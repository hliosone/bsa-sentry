// /age — an EUDIW presentation becomes an "over 18" attestation bound to the user's 0xMAIN.
//
//   POST /age/sessions            (logged in) opens an EUDIW request for the birthdate only
//   GET  /age/sessions/:id        polls it
//   POST /age/sessions/:id/bind   the Flex's Bind signature -> AgeAttestation signed by our issuer
//
// Security invariant 8: nothing about the person is stored. The birthdate is used for one
// comparison in memory; the row holds a status, the verdict and keccak256(transaction id). EUDIW_MODE=mock never calls the backend
// and says "mock" in every answer, so it cannot pass for a real verification.
import { randomBytes } from 'node:crypto';
import { Router, json } from 'express';
import { getAddress, isAddress, keccak256, recoverTypedDataAddress, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CLAIM_AGE_OVER_18, EIP712_TYPES, joinClaims, joinCredentials, jurisdictionClaim, sentryDomain, toViemSignature, toWireSignature, verifierDomain,
} from '@bsa-sentry/types';
import type { Db } from '../db.js';
import { readSession } from '../auth.js';
import { buildPresentationRequest, createTransaction, eudiTestCas, identityClaims, pollTransaction, qrUrl, readIdentity } from './eudiw.js';
import { safeRouter } from '../safe-router.js';
import { delegationHash } from '../facilitator/age.js';

const BIND_WINDOW_S = 15 * 60;
const ATTESTATION_TTL_S = 30 * 86400;

export type AgeOptions = {
  db: Db;
  chainId: number;
  issuerKey: Hex;
  secret: string;
  mode: 'mock' | 'live';
  backend: string;
  intendedUseId: string;
  qrScheme: string;
  now?: () => number;
  fetch?: typeof fetch;
  /** The PEM chain to trust for Procivis' trial issuer. Defaults to fetching the EUDI test CAs. */
  issuerChain?: () => Promise<string>;
  /** The PID field read as the jurisdiction (default `issuing_country`), e.g. ['address', 'country']. */
  countryPath?: string[];
};

type Row = {
  id: string; account: string; mode: string; verifier: string; transaction_id: string | null;
  status: string; evidence: string | null; bound_to: string | null; created_at: number; expires_at: number;
};

/** Whether the user revoked this delegation (by its EIP-712 hash). */
export function isRevoked(db: Db, delegationHashHex: string): boolean {
  return !!db.prepare('SELECT 1 FROM revocations WHERE delegation_hash = ?').get(delegationHashHex.toLowerCase());
}

export function ageRouter(o: AgeOptions) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchImpl = o.fetch ?? fetch;
  const issuer = privateKeyToAccount(o.issuerKey);
  const router = safeRouter();
  router.use(json({ limit: '8kb' }));
  const get = (id: string) => o.db.prepare('SELECT * FROM age_sessions WHERE id = ?').get(id) as Row | undefined;

  // Revoking the rights granted to an agent: the browser sends the credentials read from the
  // Flex; only the 0xMAIN that signed the delegation (logged in with its Ledger) can revoke it.
  // From then on the facilitator refuses it. Expiry still applies to everything else.
  router.post('/revoke', async (req, res) => {
    const account = readSession(req, o.secret, now);
    if (!account) return res.status(401).json({ error: 'log in with Ledger first' });
    let c;
    try {
      c = joinCredentials(req.body, BigInt(o.chainId));
    } catch {
      return res.status(400).json({ error: 'malformed credentials' });
    }
    const signer = await recoverTypedDataAddress({
      domain: sentryDomain(o.chainId), types: { AgentDelegation: EIP712_TYPES.AgentDelegation }, primaryType: 'AgentDelegation',
      message: c.delegation, signature: toViemSignature(c.delegationSig),
    }).catch(() => null);
    if (!signer || signer.toLowerCase() !== account.toLowerCase()) return res.status(403).json({ error: 'only the account that granted these rights can revoke them' });
    const hash = delegationHash(o.chainId, c.delegation);
    o.db.prepare('INSERT OR IGNORE INTO revocations (delegation_hash, account, revoked_at) VALUES (?, ?, ?)').run(hash, account.toLowerCase(), now());
    res.json({ revoked: true, delegationHash: hash });
  });

  router.get('/revoked/:hash', (req, res) => res.json({ revoked: isRevoked(o.db, String(req.params.hash)) }));

  router.post('/sessions', async (req, res) => {
    const account = readSession(req, o.secret, now);
    if (!account) return res.status(401).json({ error: 'log in with your Ledger first' });
    const id = `0x${randomBytes(32).toString('hex')}` as Hex;
    const createdAt = now();
    const expiresAt = createdAt + BIND_WINDOW_S;

    let qr: string;
    let transactionId: string;
    let verifier: string;
    if (o.mode === 'mock') {
      transactionId = `mock-${id}`;
      verifier = 'mock: BSA Sentry test verifier';
      qr = `mock://age?session=${id}`;
    } else {
      try {
        const chain = await (o.issuerChain ?? (() => eudiTestCas(fetchImpl)))().catch(() => '');
        const t = await createTransaction(fetchImpl, o.backend, buildPresentationRequest({
          nonce: randomBytes(16).toString('base64url'), intendedUseId: o.intendedUseId, ...(chain ? { issuerChain: chain } : {}),
          ...(o.countryPath ? { countryPath: o.countryPath } : {}),
        }));
        transactionId = t.transactionId;
        qr = qrUrl(o.qrScheme, t);
        verifier = o.backend;
      } catch (e) {
        return res.status(502).json({ error: (e as Error).message });
      }
    }
    o.db.prepare(`INSERT INTO age_sessions (id, account, mode, verifier, transaction_id, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, account, o.mode, verifier, transactionId, createdAt, expiresAt);
    res.json({ sessionId: id, mode: o.mode, status: 'pending', qr, bind: { verifier, session: id, expiresAt } });
  });

  // The rights a verified session proves. Re-read from the EU verifier each time rather than
  // stored: the jurisdiction only ever exists in the signed attestation on the user's Flex.
  const claimsFor = async (row: { mode: string; transaction_id: string | null }): Promise<string[]> => {
    if (row.mode === 'mock') return [CLAIM_AGE_OVER_18, jurisdictionClaim('FR')];
    try {
      const r = await pollTransaction(fetchImpl, o.backend, row.transaction_id!);
      return r.state === 'verified' ? identityClaims(readIdentity(r.vpToken, now(), o.countryPath)) : [];
    } catch {
      return [];
    }
  };

  router.get('/sessions/:id', async (req, res) => {
    const row = get(req.params.id);
    if (!row) return res.status(404).json({ error: 'unknown session' });
    let status = row.status;
    if (status === 'pending') {
      if (row.mode === 'mock') {
        status = 'verified';
      } else {
        try {
          const r = await pollTransaction(fetchImpl, o.backend, row.transaction_id!);
          // The birthdate is read for one comparison and dropped here; it is never stored or logged.
          if (r.state === 'verified') status = identityClaims(readIdentity(r.vpToken, now(), o.countryPath)).length > 0 ? 'verified' : 'not_over_18';
          else if (r.state !== 'pending') status = r.state;
        } catch {
          /* backend hiccup: stay pending, the page polls again */
        }
      }
      if (status !== 'pending') {
        const evidence = status === 'verified' ? keccak256(stringToHex(row.transaction_id!)) : null;
        o.db.prepare('UPDATE age_sessions SET status = ?, evidence = ? WHERE id = ?').run(status, evidence, row.id);
      }
    }
    res.json({ sessionId: row.id, status, mode: row.mode, ...(status === 'verified' ? { claims: await claimsFor(row) } : {}) });
  });

  router.post('/sessions/:id/bind', async (req, res) => {
    const row = get(req.params.id);
    if (!row) return res.status(404).json({ error: 'unknown session' });
    const { address, signature } = req.body ?? {};
    if (typeof address !== 'string' || !isAddress(address) || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      return res.status(400).json({ error: 'address and a 65-byte signature are required' });
    }
    if (row.expires_at <= now()) return res.status(410).json({ error: 'this age session expired; start a new one' });
    if (row.status !== 'verified') return res.status(409).json({ error: `session not verified (${row.status})` });
    if (row.bound_to) return res.status(409).json({ error: 'this session was already used' });

    let signer: Hex;
    try {
      signer = await recoverTypedDataAddress({
        domain: sentryDomain(o.chainId),
        types: { Bind: EIP712_TYPES.Bind },
        primaryType: 'Bind',
        message: { verifier: row.verifier, session: row.id as Hex, expiresAt: BigInt(row.expires_at) },
        signature: toViemSignature(signature as Hex),
      });
    } catch {
      return res.status(401).json({ error: 'invalid signature' });
    }
    if (getAddress(signer) !== getAddress(address)) return res.status(401).json({ error: 'invalid signature' });
    // The wallet presentation was opened by this account; nobody else may bind it.
    if (address.toLowerCase() !== row.account) return res.status(403).json({ error: 'this session belongs to another account' });

    // Burn the session before signing anything.
    const claimed = o.db.prepare('UPDATE age_sessions SET bound_to = ? WHERE id = ? AND bound_to IS NULL').run(address.toLowerCase(), row.id);
    if (claimed.changes !== 1) return res.status(409).json({ error: 'this session was already used' });

    const claims = await claimsFor(row);
    if (claims.length === 0) return res.status(409).json({ error: 'the wallet presentation is no longer available: start a new verification' });
    const issuedAt = now();
    const attestation = {
      subject: address.toLowerCase() as Hex,
      claim: joinClaims(claims),
      issuedAt: BigInt(issuedAt),
      expiresAt: BigInt(issuedAt + ATTESTATION_TTL_S),
      evidence: row.evidence as Hex,
    };
    const sig = await issuer.signTypedData({
      domain: verifierDomain(o.chainId),
      types: { AgeAttestation: EIP712_TYPES.AgeAttestation },
      primaryType: 'AgeAttestation',
      message: attestation,
    });
    res.json({
      attestation: { ...attestation, issuedAt: attestation.issuedAt.toString(), expiresAt: attestation.expiresAt.toString() },
      attestationSig: toWireSignature(sig),
      issuer: issuer.address,
    });
  });

  return router;
}
