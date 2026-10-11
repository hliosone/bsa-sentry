// "Se connecter avec Ledger": the Flex signs an EIP-712 Login with 0xMAIN, the server
// checks it and sets a session cookie. Every way a login can be forged or replayed fails.
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { privateKeyToAccount } from 'viem/accounts';
import { EIP712_TYPES, sentryDomain, toWireSignature } from '@bsa-sentry/types';
import { openDb } from '../src/db.js';
import { authRouter, readSession, SESSION_COOKIE, signSession } from '../src/auth.js';

const CHAIN = 5042002;
const ORIGIN = 'https://bsa-sentry.test';
const SECRET = 'x'.repeat(64);
const user = privateKeyToAccount(`0x${'31'.repeat(32)}`);

function setup(now = () => 1_760_000_000) {
  const db = openDb(':memory:');
  const app = express();
  app.use('/auth', authRouter({ db, chainId: CHAIN, origin: ORIGIN, secret: SECRET, now, secureCookie: false }));
  app.get('/whoami', (req, res) => res.json({ account: readSession(req, SECRET, now) }));
  return { db, app };
}

/** What the Flex does on SIGN_LOGIN, done here with a software key. */
async function signLogin(challenge: { nonce: string; origin: string; issuedAt: number; expiresAt: number }, signer = user) {
  const sig = await signer.signTypedData({
    domain: sentryDomain(CHAIN),
    types: { Login: EIP712_TYPES.Login },
    primaryType: 'Login',
    message: {
      origin: challenge.origin, nonce: challenge.nonce as `0x${string}`,
      issuedAt: BigInt(challenge.issuedAt), expiresAt: BigInt(challenge.expiresAt),
    },
  });
  return toWireSignature(sig); // the device returns v | r | s
}

const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));

describe('challenge', () => {
  it('returns a fresh 32-byte nonce, the expected origin and a short expiry', async () => {
    const { app } = setup();
    const a = (await request(app).post('/auth/challenge')).body;
    const b = (await request(app).post('/auth/challenge')).body;
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a).toMatchObject({ origin: ORIGIN, chainId: CHAIN, issuedAt: 1_760_000_000 });
    expect(a.expiresAt - a.issuedAt).toBeLessThanOrEqual(300);
  });
});

describe('login', () => {
  it('accepts a Login signed by the claimed 0xMAIN and sets an httpOnly session cookie', async () => {
    const { app } = setup();
    const challenge = (await request(app).post('/auth/challenge')).body;
    const res = await request(app).post('/auth/login').send({ address: user.address, nonce: challenge.nonce, signature: await signLogin(challenge) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account: user.address.toLowerCase() });
    const cookie = cookieOf(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const who = await request(app).get('/whoami').set('Cookie', cookie.split(';')[0]!);
    expect(who.body.account).toBe(user.address.toLowerCase());
  });

  it('refuses a replayed challenge', async () => {
    const { app } = setup();
    const challenge = (await request(app).post('/auth/challenge')).body;
    const body = { address: user.address, nonce: challenge.nonce, signature: await signLogin(challenge) };
    expect((await request(app).post('/auth/login').send(body)).status).toBe(200);
    const again = await request(app).post('/auth/login').send(body);
    expect(again.status).toBe(401);
    expect(again.body.error).toMatch(/nonce/i);
  });

  it('refuses an expired challenge', async () => {
    let t = 1_760_000_000;
    const { app } = setup(() => t);
    const challenge = (await request(app).post('/auth/challenge')).body;
    const signature = await signLogin(challenge);
    t += 301;
    const res = await request(app).post('/auth/login').send({ address: user.address, nonce: challenge.nonce, signature });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('refuses a Login signed for another origin (phishing site)', async () => {
    const { app } = setup();
    const challenge = (await request(app).post('/auth/challenge')).body;
    const signature = await signLogin({ ...challenge, origin: 'https://bsa-sentry.evil' });
    const res = await request(app).post('/auth/login').send({ address: user.address, nonce: challenge.nonce, signature });
    expect(res.status).toBe(401);
  });

  it('refuses a Login signed by someone other than the claimed address', async () => {
    const { app } = setup();
    const challenge = (await request(app).post('/auth/challenge')).body;
    const other = privateKeyToAccount(`0x${'32'.repeat(32)}`);
    const res = await request(app).post('/auth/login').send({ address: user.address, nonce: challenge.nonce, signature: await signLogin(challenge, other) });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature/i);
  });

  it('refuses an unknown nonce', async () => {
    const { app } = setup();
    const challenge = { nonce: `0x${'99'.repeat(32)}`, origin: ORIGIN, issuedAt: 1_760_000_000, expiresAt: 1_760_000_300 };
    const res = await request(app).post('/auth/login').send({ address: user.address, nonce: challenge.nonce, signature: await signLogin(challenge) });
    expect(res.status).toBe(401);
  });

  it('refuses malformed input without crashing', async () => {
    const { app } = setup();
    for (const body of [{}, { address: 'nope' }, { address: user.address, nonce: '0x12', signature: '0x' }]) {
      expect((await request(app).post('/auth/login').send(body)).status).toBe(400);
    }
  });

  it('a nonce that failed verification is burned, so it cannot be retried with a better signature', async () => {
    const { app } = setup();
    const challenge = (await request(app).post('/auth/challenge')).body;
    const other = privateKeyToAccount(`0x${'32'.repeat(32)}`);
    await request(app).post('/auth/login').send({ address: user.address, nonce: challenge.nonce, signature: await signLogin(challenge, other) });
    const res = await request(app).post('/auth/login').send({ address: user.address, nonce: challenge.nonce, signature: await signLogin(challenge) });
    expect(res.status).toBe(401);
  });
});

describe('session cookie', () => {
  it('is rejected when tampered with', () => {
    const now = () => 1_760_000_000;
    const good = signSession('0xabc', SECRET, now);
    const forged = good.replace('0xabc', '0xdef');
    const req = (v: string) => ({ headers: { cookie: `${SESSION_COOKIE}=${v}` } }) as any;
    expect(readSession(req(good), SECRET, now)).toBe('0xabc');
    expect(readSession(req(forged), SECRET, now)).toBeNull();
    expect(readSession(req(good), 'y'.repeat(64), now)).toBeNull();
  });

  it('expires', () => {
    const good = signSession('0xabc', SECRET, () => 1_760_000_000);
    const req = { headers: { cookie: `${SESSION_COOKIE}=${good}` } } as any;
    expect(readSession(req, SECRET, () => 1_760_000_000 + 13 * 3600)).toBeNull();
  });

  it('logout clears it', async () => {
    const { app } = setup();
    const res = await request(app).post('/auth/logout');
    expect(cookieOf(res)).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });
});
