// The live EUDIW client, against hand-made fixtures (no real personal data anywhere).
// It must build the request exactly like the team's working reference, ask for nothing but
// the age boolean, and read nothing but the age boolean back.
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildPresentationRequest, qrUrl, pollTransaction, readAgeOver18, createTransaction } from '../src/age/eudiw.js';

const b64u = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const digest = (disclosure: string) => createHash('sha256').update(disclosure, 'ascii').digest('base64url');

/** A fake SD-JWT: unsigned issuer JWT + disclosures + empty KB-JWT slot. Enough for reading. */
function sdJwt(payload: Record<string, unknown>, disclosures: string[]) {
  return `${b64u({ alg: 'ES256', typ: 'dc+sd-jwt' })}.${b64u(payload)}.sig~${disclosures.join('~')}~`;
}

describe('the request', () => {
  const body = buildPresentationRequest({ nonce: 'n0nce', intendedUseId: 'TEST-01', issuerChain: 'PEM' });

  it('matches the reference shape: DCQL, by-reference JAR, GET request_uri, openid4vp profile', () => {
    expect(body).toMatchObject({
      nonce: 'n0nce', jar_mode: 'by_reference', request_uri_method: 'get', response_mode: 'direct_post.jwt',
      profile: 'openid4vp', intended_use_id: 'TEST-01', issuer_chain: 'PEM',
    });
    expect(body.dcql_query.credentials).toHaveLength(1);
    expect(body.dcql_query.credentials[0]).toMatchObject({ format: 'dc+sd-jwt', meta: { vct_values: ['urn:eudi:pid:1'] } });
  });

  it('asks for the age boolean and nothing else, in either of its two spellings', () => {
    const cred = body.dcql_query.credentials[0]!;
    const paths = cred.claims.map((c: { path: string[] }) => c.path.join('.'));
    expect(paths.sort()).toEqual(['age_equal_or_over.18', 'age_over_18']);
    expect(cred.claim_sets).toEqual([['age_18'], ['age_over_18']]);
    expect(JSON.stringify(body)).not.toMatch(/given_name|family_name|birthdate|address|nationalit/);
  });

  it('omits issuer_chain when none is given', () => {
    expect(buildPresentationRequest({ nonce: 'x', intendedUseId: 'TEST-01' })).not.toHaveProperty('issuer_chain');
  });
});

describe('creating the transaction', () => {
  it('posts to /ui/presentations and returns what the QR needs', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      transaction_id: 'tx-1', client_id: 'x509_hash:abc', request_uri: 'https://verifier/req/1', request_uri_method: 'get',
    }), { status: 200 }));
    const t = await createTransaction(fetchImpl as any, 'https://verifier', buildPresentationRequest({ nonce: 'n', intendedUseId: 'TEST-01' }));
    expect(fetchImpl).toHaveBeenCalledWith('https://verifier/ui/presentations', expect.objectContaining({ method: 'POST' }));
    expect(t).toEqual({ transactionId: 'tx-1', clientId: 'x509_hash:abc', requestUri: 'https://verifier/req/1', requestUriMethod: 'get' });
  });

  it('throws a readable error when the backend refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'InvalidIntendedUse' }), { status: 400 }));
    await expect(createTransaction(fetchImpl as any, 'https://v', {} as any)).rejects.toThrow(/400.*InvalidIntendedUse/);
  });
});

describe('the QR code', () => {
  it('is <scheme>://? with client_id, request_uri and request_uri_method', () => {
    const u = qrUrl('openid4vp', { clientId: 'x509_hash:abc', requestUri: 'https://v/r/1', requestUriMethod: 'get' });
    expect(u.startsWith('openid4vp://?')).toBe(true);
    const q = new URLSearchParams(u.split('?')[1]);
    expect(Object.fromEntries(q)).toEqual({ client_id: 'x509_hash:abc', request_uri: 'https://v/r/1', request_uri_method: 'get' });
  });
});

describe('polling', () => {
  const backend = (events: unknown[], result?: unknown) =>
    vi.fn(async (url: string) => url.endsWith('/events')
      ? new Response(JSON.stringify({ events }), { status: 200 })
      : new Response(JSON.stringify(result ?? {}), { status: 200 }));

  it('is pending before the wallet answers, and does not fetch the result yet', async () => {
    const f = backend([{ actor: 'Verifier', event: 'Transaction initialized' }, { actor: 'Wallet', event: 'Request object retrieved' }]);
    expect(await pollTransaction(f as any, 'https://v', 'tx')).toEqual({ state: 'pending' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('ignores the "failed to get wallet" noise the result endpoint logs when polled early', async () => {
    const f = backend([{ actor: 'Verifier', event: 'Verifier failed to get wallet', cause: 'Presentation should be in Submitted state' }]);
    expect((await pollTransaction(f as any, 'https://v', 'tx')).state).toBe('pending');
  });

  it('returns the vp_token once the backend verified the presentation', async () => {
    const f = backend([{ actor: 'Wallet', event: 'Wallet response posted' }], { vp_token: { pid: ['t'] } });
    expect(await pollTransaction(f as any, 'https://v', 'tx')).toEqual({ state: 'verified', vpToken: { pid: ['t'] } });
  });

  it('reports a presentation the backend refused, with its cause', async () => {
    const f = backend([{ actor: 'Wallet', event: 'Verifier refused', cause: 'IssuerCertificateIsNotTrusted' }]);
    expect(await pollTransaction(f as any, 'https://v', 'tx')).toEqual({ state: 'rejected', cause: 'IssuerCertificateIsNotTrusted' });
  });

  it('reports a wallet that declined', async () => {
    const f = backend([{ actor: 'Wallet', event: 'Wallet response posted' }], { error: 'access_denied' });
    expect(await pollTransaction(f as any, 'https://v', 'tx')).toEqual({ state: 'wallet_error', cause: 'access_denied' });
  });
});

describe('reading the answer', () => {
  it('finds age_equal_or_over.18 behind nested selective disclosures', () => {
    const d18 = b64u(['salt2', '18', true]);
    const dAge = b64u(['salt1', 'age_equal_or_over', { _sd: [digest(d18)] }]);
    const token = sdJwt({ _sd: [digest(dAge)], _sd_alg: 'sha-256', vct: 'urn:eudi:pid:1' }, [dAge, d18]);
    expect(readAgeOver18({ pid: [token] })).toBe(true);
  });

  it('finds the older flat age_over_18', () => {
    const d = b64u(['salt', 'age_over_18', true]);
    expect(readAgeOver18({ pid: [sdJwt({ _sd: [digest(d)] }, [d])] })).toBe(true);
  });

  it('is false for someone under 18', () => {
    const d = b64u(['salt', 'age_over_18', false]);
    expect(readAgeOver18({ pid: [sdJwt({ _sd: [digest(d)] }, [d])] })).toBe(false);
  });

  it('is false when the claim is missing or is not exactly the boolean true', () => {
    const d = b64u(['salt', 'age_over_18', 'yes']);
    expect(readAgeOver18({ pid: [sdJwt({ _sd: [digest(d)] }, [d])] })).toBe(false);
    expect(readAgeOver18({ pid: [sdJwt({}, [])] })).toBe(false);
  });

  it('ignores a disclosure whose digest is not in the signed payload (injected claim)', () => {
    const d = b64u(['salt', 'age_over_18', true]);
    expect(readAgeOver18({ pid: [sdJwt({ _sd: ['not-the-digest'] }, [d])] })).toBe(false);
  });

  it('survives garbage', () => {
    expect(readAgeOver18({ pid: ['not an sd-jwt'] })).toBe(false);
    expect(readAgeOver18(null)).toBe(false);
  });
});
