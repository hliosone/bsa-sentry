// /age: an EUDIW presentation becomes an "over 18" attestation bound to the user's 0xMAIN.
// Mock mode for the lifecycle; the live mode's backend calls are injected.
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, recoverTypedDataAddress, stringToHex, type Hex } from 'viem';
import { EIP712_TYPES, sentryDomain, toViemSignature, toWireSignature, verifierDomain } from '@bsa-sentry/types';
import { openDb } from '../src/db.js';
import { signSession, SESSION_COOKIE } from '../src/auth.js';
import { ageRouter } from '../src/age/routes.js';

const CHAIN = 5042002;
const SECRET = 'k'.repeat(64);
const issuer = privateKeyToAccount(`0x${'b1'.repeat(32)}`);
const user = privateKeyToAccount(`0x${'b2'.repeat(32)}`);
const other = privateKeyToAccount(`0x${'b3'.repeat(32)}`);

function setup(over: Record<string, unknown> = {}, clock = { t: 1_760_000_000 }) {
  const db = openDb(':memory:');
  const app = express();
  app.use('/age', ageRouter({
    db, chainId: CHAIN, issuerKey: `0x${'b1'.repeat(32)}`, secret: SECRET, now: () => clock.t,
    mode: 'mock', backend: 'https://verifier.test', intendedUseId: 'TEST-01', qrScheme: 'openid4vp',
    ...over,
  } as any));
  return { app, db, clock };
}

const cookie = (account = user.address.toLowerCase()) => `${SESSION_COOKIE}=${encodeURIComponent(signSession(account, SECRET, () => 1_760_000_000))}`;

async function signBind(bind: { verifier: string; session: Hex; expiresAt: number }, signer = user) {
  return toWireSignature(await signer.signTypedData({
    domain: sentryDomain(CHAIN), types: { Bind: EIP712_TYPES.Bind }, primaryType: 'Bind',
    message: { verifier: bind.verifier, session: bind.session, expiresAt: BigInt(bind.expiresAt) },
  }));
}

describe('mock mode', () => {
  it('answers 500 instead of crashing the server when the database fails', async () => {
    // Express 4 does not catch errors from async handlers: one of them took the whole server
    // down, and with it the connection to the user's Flex.
    const { app, db } = setup();
    db.exec('DROP TABLE age_sessions;');
    const r = await request(app).post('/age/sessions').set('Cookie', cookie());
    expect(r.status).toBe(500);
    expect(r.body.error).toBeTruthy();
  });

  it('creating a session needs a Ledger login', async () => {
    const { app } = setup();
    expect((await request(app).post('/age/sessions')).status).toBe(401);
  });

  it('creates a session with a QR and the fields the Flex will sign, labelled as mock', async () => {
    const { app } = setup();
    const r = await request(app).post('/age/sessions').set('Cookie', cookie());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'mock', status: 'pending' });
    expect(r.body.sessionId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.body.bind).toMatchObject({ session: r.body.sessionId });
    expect(r.body.bind.verifier).toMatch(/mock/i);
    expect(r.body.qr).toMatch(/^mock:/);
  });

  it('reports verified on poll, and says mock', async () => {
    const { app } = setup();
    const s = (await request(app).post('/age/sessions').set('Cookie', cookie())).body;
    const st = await request(app).get(`/age/sessions/${s.sessionId}`);
    expect(st.body).toEqual({ sessionId: s.sessionId, status: 'verified', mode: 'mock', claims: ['age_over_18', 'nationality:FR'] });
  });

  it('binds once, and returns an AgeAttestation signed by our issuer for this 0xMAIN', async () => {
    const { app, clock } = setup();
    const s = (await request(app).post('/age/sessions').set('Cookie', cookie())).body;
    await request(app).get(`/age/sessions/${s.sessionId}`);
    const r = await request(app).post(`/age/sessions/${s.sessionId}/bind`).send({ address: user.address, signature: await signBind(s.bind) });
    expect(r.status).toBe(200);
    const a = r.body.attestation;
    expect(a).toMatchObject({ subject: user.address.toLowerCase(), claim: 'age_over_18,nationality:FR', issuedAt: String(clock.t), expiresAt: String(clock.t + 30 * 86400) });
    expect(a.evidence).toBe(keccak256(stringToHex(`mock-${s.sessionId}`)));
    const signer = await recoverTypedDataAddress({
      domain: verifierDomain(CHAIN), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation',
      message: { ...a, issuedAt: BigInt(a.issuedAt), expiresAt: BigInt(a.expiresAt) },
      signature: toViemSignature(r.body.attestationSig),
    });
    expect(signer).toBe(issuer.address);

    const again = await request(app).post(`/age/sessions/${s.sessionId}/bind`).send({ address: user.address, signature: await signBind(s.bind) });
    expect(again.status).toBe(409);
  });

  it('refuses a Bind signed by someone else than the claimed address', async () => {
    const { app } = setup();
    const s = (await request(app).post('/age/sessions').set('Cookie', cookie())).body;
    await request(app).get(`/age/sessions/${s.sessionId}`);
    const r = await request(app).post(`/age/sessions/${s.sessionId}/bind`).send({ address: user.address, signature: await signBind(s.bind, other) });
    expect(r.status).toBe(401);
  });

  it('refuses to bind a session that is not verified yet', async () => {
    const { app } = setup({ mode: 'live', fetch: vi.fn(async (url: string) => url.endsWith('/events')
      ? new Response(JSON.stringify({ events: [] })) : new Response(JSON.stringify({ transaction_id: 'tx', client_id: 'c', request_uri: 'r', request_uri_method: 'get' }))), issuerChain: async () => '' });
    const s = (await request(app).post('/age/sessions').set('Cookie', cookie())).body;
    const r = await request(app).post(`/age/sessions/${s.sessionId}/bind`).send({ address: user.address, signature: await signBind(s.bind) });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/not verified/i);
  });

  it('refuses an expired session', async () => {
    const { app, clock } = setup();
    const s = (await request(app).post('/age/sessions').set('Cookie', cookie())).body;
    await request(app).get(`/age/sessions/${s.sessionId}`);
    clock.t += 16 * 60;
    const r = await request(app).post(`/age/sessions/${s.sessionId}/bind`).send({ address: user.address, signature: await signBind(s.bind) });
    expect(r.status).toBe(410);
  });

  it('refuses to bind someone else\'s session', async () => {
    const { app } = setup();
    const s = (await request(app).post('/age/sessions').set('Cookie', cookie())).body;
    await request(app).get(`/age/sessions/${s.sessionId}`);
    // Other signs a valid Bind for the session Alice opened.
    const r = await request(app).post(`/age/sessions/${s.sessionId}/bind`).send({ address: other.address, signature: await signBind(s.bind, other) });
    expect(r.status).toBe(403);
  });

  it('answers 404 for an unknown session', async () => {
    const { app } = setup();
    expect((await request(app).get(`/age/sessions/0x${'00'.repeat(32)}`)).status).toBe(404);
  });
});

describe('live mode', () => {
  const tx = { transaction_id: 'tx-77', client_id: 'x509_hash:abc', request_uri: 'https://verifier.test/r/1', request_uri_method: 'get' };

  it('creates the EUDIW transaction exactly as documented and builds the openid4vp QR', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(tx)));
    const { app } = setup({ mode: 'live', fetch: fetchImpl, issuerChain: async () => 'PEM-CAS' });
    const r = await request(app).post('/age/sessions').set('Cookie', cookie());
    expect(r.body).toMatchObject({ mode: 'live', status: 'pending' });
    expect(r.body.qr).toBe('openid4vp://?client_id=x509_hash%3Aabc&request_uri=https%3A%2F%2Fverifier.test%2Fr%2F1&request_uri_method=get');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://verifier.test/ui/presentations');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ intended_use_id: 'TEST-01', issuer_chain: 'PEM-CAS', profile: 'openid4vp' });
    expect(r.body.bind.verifier).toBe('https://verifier.test');
  });

  it('marks a verified presentation without a usable birthdate as not_over_18, and refuses to bind it', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      call++;
      if (call === 1) return new Response(JSON.stringify(tx));
      if (url.endsWith('/events')) return new Response(JSON.stringify({ events: [{ actor: 'Wallet', event: 'Wallet response posted' }] }));
      return new Response(JSON.stringify({ vp_token: { pid: ['not-an-sd-jwt'] } }));
    });
    const { app } = setup({ mode: 'live', fetch: fetchImpl, issuerChain: async () => '' });
    const s = (await request(app).post('/age/sessions').set('Cookie', cookie())).body;
    expect((await request(app).get(`/age/sessions/${s.sessionId}`)).body.status).toBe('not_over_18');
    expect((await request(app).post(`/age/sessions/${s.sessionId}/bind`).send({ address: user.address, signature: await signBind(s.bind) })).status).toBe(409);
  });

  it('stores no presentation data: only status, verdict and the evidence hash', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      call++;
      if (call === 1) return new Response(JSON.stringify(tx));
      if (url.endsWith('/events')) return new Response(JSON.stringify({ events: [{ actor: 'Wallet', event: 'Wallet response posted' }] }));
      return new Response(JSON.stringify({ vp_token: { pid: ['eyJhbGciOiJ4In0.eyJnaXZlbl9uYW1lIjoiU0VDUkVUIn0.s~'] } }));
    });
    const { app, db } = setup({ mode: 'live', fetch: fetchImpl, issuerChain: async () => '' });
    const s = (await request(app).post('/age/sessions').set('Cookie', cookie())).body;
    await request(app).get(`/age/sessions/${s.sessionId}`);
    const dump = JSON.stringify(db.prepare('SELECT * FROM age_sessions').all());
    expect(dump).not.toMatch(/eyJ|SECRET|given_name|vp_token/);
  });
});
