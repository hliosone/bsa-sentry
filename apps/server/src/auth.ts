// "Se connecter avec Ledger".
//
// The server issues a one-time challenge; the Flex signs an EIP-712 `Login` with 0xMAIN
// (always with a tap, invariant 5); the server recovers the signer and sets a session cookie.
// The account id IS the 0xMAIN address. A nonce is burned on first use, success or not, so a
// failed attempt cannot be retried with a better signature.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Router, json, type Request } from 'express';
import { getAddress, isAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { EIP712_TYPES, sentryDomain, toViemSignature } from '@bsa-sentry/types';
import type { Db } from './db.js';

export const SESSION_COOKIE = 'bsa_session';
const CHALLENGE_TTL_S = 300;
const SESSION_TTL_S = 12 * 3600;

export type AuthOptions = {
  db: Db;
  chainId: number;
  /** The website origin the Login must name. A Login signed for any other origin is refused. */
  origin: string;
  secret: string;
  now?: () => number;
  /** `Secure` on the cookie. Off only for plain-http local dev and tests. */
  secureCookie?: boolean;
};

const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

/** `account.expiresAt.mac` — stateless, so a server restart does not log everyone out. */
export function signSession(account: string, secret: string, now = () => Math.floor(Date.now() / 1000)): string {
  const body = `${account}.${now() + SESSION_TTL_S}`;
  return `${body}.${hmac(secret, body)}`;
}

/** The logged-in account, or null. Works on Express requests and raw upgrade requests. */
export function readSession(req: Request | IncomingMessage, secret: string, now = () => Math.floor(Date.now() / 1000)): string | null {
  const header = req.headers.cookie ?? '';
  const raw = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;
  const parts = decodeURIComponent(raw).split('.');
  if (parts.length !== 3) return null;
  const [account, exp, mac] = parts as [string, string, string];
  const expected = hmac(secret, `${account}.${exp}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) <= now()) return null;
  return account;
}

export function authRouter(opts: AuthOptions) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const router = Router();
  router.use(json({ limit: '8kb' }));

  const cookie = (value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${opts.secureCookie === false ? '' : '; Secure'}`;

  router.post('/challenge', (_req, res) => {
    const nonce = `0x${randomBytes(32).toString('hex')}`;
    const issuedAt = now();
    const expiresAt = issuedAt + CHALLENGE_TTL_S;
    opts.db.prepare('INSERT INTO login_nonces (nonce, origin, issued_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(nonce, opts.origin, issuedAt, expiresAt);
    res.json({ nonce, origin: opts.origin, issuedAt, expiresAt, chainId: opts.chainId });
  });

  router.post('/login', async (req, res) => {
    const { address, nonce, signature } = req.body ?? {};
    if (typeof address !== 'string' || !isAddress(address)
      || typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce)
      || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return res.status(400).json({ error: 'address, nonce and a 65-byte signature are required' });
    }

    const row = opts.db.prepare('SELECT origin, issued_at, expires_at, used FROM login_nonces WHERE nonce = ?').get(nonce) as
      | { origin: string; issued_at: number; expires_at: number; used: number } | undefined;
    if (!row || row.used) return res.status(401).json({ error: 'unknown or already used nonce' });
    // Burn it now, whatever happens next.
    opts.db.prepare('UPDATE login_nonces SET used = 1 WHERE nonce = ?').run(nonce);
    if (row.expires_at <= now()) return res.status(401).json({ error: 'challenge expired' });

    let signer: Hex;
    try {
      signer = await recoverTypedDataAddress({
        domain: sentryDomain(opts.chainId),
        types: { Login: EIP712_TYPES.Login },
        primaryType: 'Login',
        message: { origin: row.origin, nonce: nonce as Hex, issuedAt: BigInt(row.issued_at), expiresAt: BigInt(row.expires_at) },
        // The device returns v | r | s.
        signature: toViemSignature(signature as Hex),
      });
    } catch {
      return res.status(401).json({ error: 'invalid signature' });
    }
    // The origin is part of the signed message, so a Login made for a phishing origin
    // recovers to a different address and fails here too.
    if (getAddress(signer) !== getAddress(address)) return res.status(401).json({ error: 'invalid signature' });

    const account = address.toLowerCase();
    res.setHeader('Set-Cookie', cookie(signSession(account, opts.secret, now), SESSION_TTL_S));
    res.json({ account });
  });

  router.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', cookie('', 0));
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const account = readSession(req, opts.secret, now);
    if (!account) return res.status(401).json({ error: 'not logged in' });
    res.json({ account });
  });

  return router;
}
