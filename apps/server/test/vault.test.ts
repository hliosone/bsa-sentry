// /vault/:main — holds the Key Ring backup, as ciphertext only (security invariant 8).
// Only whoever controls 0xMAIN may write it: a Ledger login session for that address, or an
// AgentDelegation signed by it. Both are 0xMAIN signatures made on the Flex with a tap.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { EIP712_TYPES, sentryDomain, toWireSignature } from '@bsa-sentry/types';
import { openDb } from '../src/db.js';
import { signSession, SESSION_COOKIE } from '../src/auth.js';
import { vaultRouter } from '../src/vault.js';

const CHAIN = 5042002;
const SECRET = 'v'.repeat(64);
const alice = privateKeyToAccount(`0x${'c1'.repeat(32)}`);
const bob = privateKeyToAccount(`0x${'c2'.repeat(32)}`);
const A = alice.address.toLowerCase();

function setup() {
  const db = openDb(':memory:');
  const app = express();
  app.use('/vault', vaultRouter({ db, chainId: CHAIN, secret: SECRET, now: () => 1_760_000_000 }));
  return { app, db };
}
const session = (acct: string) => `${SESSION_COOKIE}=${encodeURIComponent(signSession(acct, SECRET, () => 1_760_000_000))}`;
const CIPHER = Buffer.from('opaque ciphertext from the Key Ring').toString('base64');

async function delegationBy(signer: typeof alice) {
  const message = {
    agent: '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' as const, agentName: 'Claude', attestation: `0x${'03'.repeat(32)}` as const,
    claims: ['age_over_18'], expiresAt: 1_762_592_000n, nonce: `0x${'04'.repeat(32)}` as const,
  };
  const signature = toWireSignature(await signer.signTypedData({
    domain: sentryDomain(CHAIN), types: { AgentDelegation: EIP712_TYPES.AgentDelegation }, primaryType: 'AgentDelegation', message,
  }));
  return { message: { ...message, expiresAt: message.expiresAt.toString() }, signature };
}

describe('writing', () => {
  it('accepts a backup from the logged-in owner and reads it back', async () => {
    const { app } = setup();
    expect((await request(app).put(`/vault/${A}`).set('Cookie', session(A)).send({ ciphertext: CIPHER })).status).toBe(200);
    const r = await request(app).get(`/vault/${A}`).set('Cookie', session(A));
    expect(r.status).toBe(200);
    expect(r.body.ciphertext).toBe(CIPHER);
  });

  it('accepts a backup authorised by an AgentDelegation signed by the owner', async () => {
    const { app } = setup();
    const r = await request(app).put(`/vault/${A}`).send({ ciphertext: CIPHER, delegation: await delegationBy(alice) });
    expect(r.status).toBe(200);
  });

  it('refuses a delegation signed by someone else', async () => {
    const { app } = setup();
    expect((await request(app).put(`/vault/${A}`).send({ ciphertext: CIPHER, delegation: await delegationBy(bob) })).status).toBe(403);
  });

  it('refuses another account\'s session', async () => {
    const { app } = setup();
    expect((await request(app).put(`/vault/${A}`).set('Cookie', session(bob.address.toLowerCase())).send({ ciphertext: CIPHER })).status).toBe(403);
  });

  it('refuses an anonymous write', async () => {
    const { app } = setup();
    expect((await request(app).put(`/vault/${A}`).send({ ciphertext: CIPHER })).status).toBe(403);
  });

  it('overwrites the previous backup for the same owner', async () => {
    const { app } = setup();
    await request(app).put(`/vault/${A}`).set('Cookie', session(A)).send({ ciphertext: CIPHER });
    const newer = Buffer.from('newer').toString('base64');
    await request(app).put(`/vault/${A}`).set('Cookie', session(A)).send({ ciphertext: newer });
    expect((await request(app).get(`/vault/${A}`).set('Cookie', session(A))).body.ciphertext).toBe(newer);
  });

  it('rejects anything that is not base64, or too large, or a malformed address', async () => {
    const { app } = setup();
    expect((await request(app).put(`/vault/${A}`).set('Cookie', session(A)).send({ ciphertext: 'not base64 !!' })).status).toBe(400);
    expect((await request(app).put(`/vault/${A}`).set('Cookie', session(A)).send({ ciphertext: 'A'.repeat(20_000) })).status).toBe(413);
    expect((await request(app).put('/vault/nope').set('Cookie', session(A)).send({ ciphertext: CIPHER })).status).toBe(400);
  });

  it('stores only what it was given: no plaintext field exists', async () => {
    const { app, db } = setup();
    await request(app).put(`/vault/${A}`).set('Cookie', session(A)).send({ ciphertext: CIPHER, policy: { secret: true } });
    const row = db.prepare('SELECT * FROM vault').get() as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['account', 'ciphertext', 'delegation', 'updated_at']);
    expect(JSON.stringify(row)).not.toContain('secret');
  });
});

describe('reading', () => {
  it('needs the owner\'s session', async () => {
    const { app } = setup();
    await request(app).put(`/vault/${A}`).set('Cookie', session(A)).send({ ciphertext: CIPHER });
    expect((await request(app).get(`/vault/${A}`)).status).toBe(403);
    expect((await request(app).get(`/vault/${A}`).set('Cookie', session(bob.address.toLowerCase()))).status).toBe(403);
  });

  it('answers 404 when there is no backup', async () => {
    const { app } = setup();
    expect((await request(app).get(`/vault/${A}`).set('Cookie', session(A))).status).toBe(404);
  });
});
