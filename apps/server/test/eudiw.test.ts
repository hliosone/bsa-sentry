// The live EUDIW client, against hand-made fixtures (no real personal data anywhere).
// It must build the request exactly like the team's working reference, ask for nothing but
// the age boolean, and read nothing but the age boolean back.
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildPresentationRequest, qrUrl, pollTransaction, readAgeOver18, readIdentity, identityClaims, createTransaction } from '../src/age/eudiw.js';

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

  it('asks for the birthdate and the nationalities, nothing else, as plain paths (no claim_sets)', () => {
    const cred = body.dcql_query.credentials[0]!;
    expect(cred.claims).toEqual([{ path: ['birthdate'] }, { path: ['nationalities'] }]);
    // The country field is configurable, nested paths included.
    const alt = buildPresentationRequest({ nonce: 'n', intendedUseId: 'TEST-01', countryPath: ['address', 'country'] });
    expect(alt.dcql_query.credentials[0]!.claims).toEqual([{ path: ['birthdate'] }, { path: ['address', 'country'] }]);
    // Procivis One answered "credential missing" to a query using claim_sets.
    expect(cred).not.toHaveProperty('claim_sets');
    expect(JSON.stringify(body)).not.toMatch(/given_name|family_name|address|age_over/);
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

describe('reading the answer: over 18 computed from the birthdate', () => {
  const NOW = Date.UTC(2026, 9, 11) / 1000; // 11 Oct 2026
  const token = (birthdate: unknown) => {
    const d = b64u(['salt', 'birthdate', birthdate]);
    return { pid: [sdJwt({ _sd: [digest(d)], _sd_alg: 'sha-256', vct: 'urn:eudi:pid:1' }, [d])] };
  };

  it('is true for an adult', () => {
    expect(readAgeOver18(token('1990-01-15'), NOW)).toBe(true);
  });

  it('is true on the 18th birthday itself', () => {
    expect(readAgeOver18(token('2008-10-11'), NOW)).toBe(true);
  });

  it('is false the day before the 18th birthday', () => {
    expect(readAgeOver18(token('2008-10-12'), NOW)).toBe(false);
  });

  it('counts a 29 February birthday as reached on 1 March in a non-leap year (the conservative rule)', () => {
    expect(readAgeOver18(token('2008-02-29'), Date.UTC(2026, 1, 28) / 1000)).toBe(false);
    expect(readAgeOver18(token('2008-02-29'), Date.UTC(2026, 2, 1) / 1000)).toBe(true);
  });

  it('is false for a malformed or impossible date', () => {
    for (const bad of ['15/01/1990', '1990-13-01', '1990-02-30', '', 19900115, null, '1990-01-15T00:00:00Z extra']) {
      expect(readAgeOver18(token(bad), NOW), String(bad)).toBe(false);
    }
  });

  it('is false when the birthdate is missing', () => {
    expect(readAgeOver18({ pid: [sdJwt({}, [])] }, NOW)).toBe(false);
  });

  it('ignores a disclosure whose digest is not in the signed payload (injected birthdate)', () => {
    const d = b64u(['salt', 'birthdate', '1990-01-15']);
    expect(readAgeOver18({ pid: [sdJwt({ _sd: ['not-the-digest'] }, [d])] }, NOW)).toBe(false);
  });

  it('finds a birthdate behind a nested selective disclosure too', () => {
    const inner = b64u(['s2', 'birthdate', '1990-01-15']);
    const outer = b64u(['s1', 'person', { _sd: [digest(inner)] }]);
    // Only a top-level birthdate counts: a nested one is a different claim.
    expect(readAgeOver18({ pid: [sdJwt({ _sd: [digest(outer)] }, [outer, inner])] }, NOW)).toBe(false);
  });

  it('survives garbage', () => {
    expect(readAgeOver18({ pid: ['not an sd-jwt'] }, NOW)).toBe(false);
    expect(readAgeOver18(null, NOW)).toBe(false);
  });
});

describe('reading the answer: the rights it proves', () => {
  const NOW = Date.UTC(2026, 9, 11) / 1000;
  const token = (claims: Record<string, unknown>) => {
    const ds = Object.entries(claims).map(([k, v]) => b64u(['salt', k, v]));
    return { pid: [sdJwt({ _sd: ds.map(digest), _sd_alg: 'sha-256', vct: 'urn:eudi:pid:1' }, ds)] };
  };

  it('reads the age and the disclosed nationality, nothing else', () => {
    expect(readIdentity(token({ birthdate: '1990-01-15', nationalities: ['FR', 'CH'] }), NOW)).toEqual({ ageOver18: true, country: 'FR' });
    expect(readIdentity(token({ birthdate: '2015-01-15' }), NOW)).toEqual({ ageOver18: false, country: null });
    // A configured field instead of nationalities.
    expect(readIdentity(token({ birthdate: '1990-01-15', address: { country: 'DE' } }), NOW, ['address', 'country'])).toEqual({ ageOver18: true, country: 'DE' });
  });

  it('never takes the jurisdiction from anything the wallet did not disclose', () => {
    // An undisclosed nationality, a plain issuing_country, the issuer certificate: none count.
    const bd = b64u(['salt', 'birthdate', '1990-01-15']);
    const nat = b64u(['salt', 'nationalities', ['CH']]);
    const header = b64u({ alg: 'ES256', typ: 'dc+sd-jwt', x5c: ['MIIB'] });
    const payload = b64u({ _sd: [digest(bd), digest(nat)], _sd_alg: 'sha-256', vct: 'urn:eudi:pid:1', issuing_country: 'CH' });
    expect(readIdentity({ pid: [`${header}.${payload}.sig~${bd}~`] }, NOW)).toEqual({ ageOver18: true, country: null });
  });

  it('reads nationalities whose elements are disclosed one by one (the EU reference PID)', () => {
    const el = b64u(['salt', 'CH']);
    const arr = b64u(['salt', 'nationalities', [{ '...': digest(el) }]]);
    const bd = b64u(['salt', 'birthdate', '1990-01-15']);
    const vp = { pid: [sdJwt({ _sd: [digest(bd), digest(arr)], _sd_alg: 'sha-256', vct: 'urn:eudi:pid:1' }, [bd, arr, el])] };
    expect(readIdentity(vp, NOW, ['nationalities'])).toEqual({ ageOver18: true, country: 'CH' });
    // An element whose disclosure is missing is simply absent.
    const hidden = { pid: [sdJwt({ _sd: [digest(bd), digest(arr)], _sd_alg: 'sha-256', vct: 'urn:eudi:pid:1' }, [bd, arr])] };
    expect(readIdentity(hidden, NOW, ['nationalities'])).toEqual({ ageOver18: true, country: null });
  });

  it('turns them into rights: 18+ if adult, and the first nationality (one fits in the attestation)', () => {
    expect(identityClaims({ ageOver18: true, country: 'fr' })).toEqual(['age_over_18', 'jurisdiction:FR']);
    expect(identityClaims({ ageOver18: false, country: 'FR' })).toEqual(['jurisdiction:FR']);
    expect(identityClaims({ ageOver18: false, country: 'France' })).toEqual([]);
  });
});
