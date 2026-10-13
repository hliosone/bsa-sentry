// Client for the public EUDI reference verifier backend (OpenID4VP 1.0 + DCQL), ported from
// the team's working integration in ../eudi-verifier-test (see docs/EUDIW.md).
//
// The PID has no age_over_18 claim: we request ONLY `birthdate` (not the name the test page also
// asked for) and compute "18 or older" here. The birthdate lives in readAgeOver18's locals for one
// comparison and is never stored or logged (security invariant 8): only the boolean survives.
// Signatures are not re-checked here: a "Wallet response posted" transaction has already been
// verified by the backend (issuer signature, KB-JWT, nonce).
import { createHash } from 'node:crypto';
import { CLAIM_AGE_OVER_18, nationalityClaim } from '@bsa-sentry/types';

export const PID_VCT = 'urn:eudi:pid:1';

/** Procivis' trial EUDI issuer chains to these; the public backend does not trust them by default. */
export const EUDI_TEST_CAS = [
  'https://preprod.pki.eudiw.dev/aia/PIDIssuerCA02-UT.cacert.pem',
  'https://preprod.pki.eudiw.dev/aia/PIDIssuerCA02-EU.cacert.pem',
];

export function buildPresentationRequest(o: { nonce: string; intendedUseId: string; issuerChain?: string }) {
  return {
    dcql_query: {
      credentials: [{
        id: 'pid',
        format: 'dc+sd-jwt',
        meta: { vct_values: [PID_VCT] },
        // Data minimisation: the birthdate (for "18 or older") and the nationality (for the
        // jurisdiction right), nothing else. Plain paths, exactly like the team's working
        // reference: Procivis answered "credential missing" to a query with claim_sets.
        claims: [{ path: ['birthdate'] }, { path: ['nationalities'] }],
      }],
    },
    nonce: o.nonce,
    jar_mode: 'by_reference',
    request_uri_method: 'get',
    response_mode: 'direct_post.jwt',
    profile: 'openid4vp',
    intended_use_id: o.intendedUseId,
    ...(o.issuerChain ? { issuer_chain: o.issuerChain } : {}),
  };
}

export type Transaction = { transactionId: string; clientId: string; requestUri: string; requestUriMethod: string };

export async function createTransaction(fetchImpl: typeof fetch, backend: string, body: unknown): Promise<Transaction> {
  const res = await fetchImpl(`${backend}/ui/presentations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, string>;
  if (res.status !== 200) throw new Error(`EUDI verifier refused the transaction: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return { transactionId: json.transaction_id!, clientId: json.client_id!, requestUri: json.request_uri!, requestUriMethod: json.request_uri_method ?? 'get' };
}

export function qrUrl(scheme: string, t: Pick<Transaction, 'clientId' | 'requestUri' | 'requestUriMethod'>) {
  const q = new URLSearchParams({ client_id: t.clientId, request_uri: t.requestUri, request_uri_method: t.requestUriMethod });
  return `${scheme}://?${q.toString()}`;
}

export type PollResult =
  | { state: 'pending' }
  | { state: 'verified'; vpToken: unknown }
  | { state: 'rejected'; cause: string }
  | { state: 'wallet_error'; cause: string };

/** Polling the result endpoint early makes the backend log this; it is not a wallet event. */
const isPollNoise = (e: any) => e?.event === 'Verifier failed to get wallet' && /should be in Submitted state/.test(e?.cause ?? '');

export async function pollTransaction(fetchImpl: typeof fetch, backend: string, tx: string): Promise<PollResult> {
  const id = encodeURIComponent(tx);
  const ev = await (await fetchImpl(`${backend}/ui/presentations/${id}/events`)).json().catch(() => ({})) as { events?: any[] };
  const events = (ev.events ?? []).filter((e) => !isPollNoise(e));
  const lastWallet = events.filter((e) => e.actor === 'Wallet' && e.event !== 'Request object retrieved').at(-1);
  if (!lastWallet) return { state: 'pending' };
  if (lastWallet.event !== 'Wallet response posted') return { state: 'rejected', cause: String(lastWallet.cause ?? lastWallet.event) };
  const result = await (await fetchImpl(`${backend}/ui/presentations/${id}`)).json().catch(() => ({})) as Record<string, unknown>;
  if (!result.vp_token) return { state: 'wallet_error', cause: String(result.error ?? 'no vp_token') };
  return { state: 'verified', vpToken: result.vp_token };
}

/**
 * "18 or older" from a verified vp_token's `birthdate` (ISO `YYYY-MM-DD`), at `nowSeconds`.
 * Anything malformed is "not proven". A 29 February birthday is reached on 1 March in a
 * non-leap year (the conservative reading).
 */
export function readAgeOver18(vpToken: unknown, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return readIdentity(vpToken, nowSeconds).ageOver18;
}

/**
 * The two facts we derive from a verified presentation: "18 or older", and the nationalities
 * (ISO codes). The birthdate never leaves this function; nothing here is stored.
 */
export function readIdentity(vpToken: unknown, nowSeconds = Math.floor(Date.now() / 1000)): { ageOver18: boolean; nationalities: string[] } {
  let ageOver18 = false;
  const nationalities: string[] = [];
  try {
    for (const presentations of Object.values((vpToken ?? {}) as Record<string, unknown>)) {
      for (const p of ([] as unknown[]).concat(presentations)) {
        if (typeof p !== 'string' || !p.includes('~')) continue;
        const claims = resolveSdJwt(p);
        if (isAtLeast18(claims.birthdate, nowSeconds)) ageOver18 = true;
        for (const n of ([] as unknown[]).concat(claims.nationalities ?? [])) {
          if (typeof n === 'string' && !nationalities.includes(n)) nationalities.push(n);
        }
      }
    }
  } catch {
    /* malformed: treated as "not proven" */
  }
  return { ageOver18, nationalities };
}

/** The rights to attest: 18+ if adult, and the first valid nationality (one fits in 32 bytes). */
export function identityClaims(i: { ageOver18: boolean; nationalities: string[] }): string[] {
  const out: string[] = i.ageOver18 ? [CLAIM_AGE_OVER_18] : [];
  const n = i.nationalities.find((c) => /^[a-zA-Z]{2}$/.test(c));
  if (n) out.push(nationalityClaim(n));
  return out;
}

function isAtLeast18(birthdate: unknown, nowSeconds: number): boolean {
  if (typeof birthdate !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Reject impossible dates (2026-02-30 would otherwise roll over to March).
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return false;
  const today = new Date(nowSeconds * 1000);
  const now = [today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()];
  const eighteenth = [y + 18, mo, d];
  // Lexicographic (year, month, day) comparison: 29 Feb compares after 28 Feb, so in a
  // non-leap year the birthday is reached on 1 March.
  for (let i = 0; i < 3; i++) {
    if (now[i]! !== eighteenth[i]!) return now[i]! > eighteenth[i]!;
  }
  return true;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Minimal SD-JWT resolution (the reference's algorithm): only disclosures whose digest the signed payload lists count. */
function resolveSdJwt(token: string): Record<string, unknown> {
  const parts = token.split('~');
  const payload = b64json(parts[0]!.split('.')[1]!);
  const alg = String(payload._sd_alg ?? 'sha-256').replace('-', '');
  const byDigest = new Map<string, unknown[]>();
  for (const d of parts.slice(1).filter(Boolean)) {
    try {
      const decoded = b64json(d);
      if (Array.isArray(decoded)) byDigest.set(createHash(alg).update(d, 'ascii').digest('base64url'), decoded);
    } catch { /* the trailing KB-JWT, or junk */ }
  }
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) if (k !== '_sd' && k !== '_sd_alg') out[k] = resolve(v);
      for (const dg of ((node as { _sd?: string[] })._sd ?? [])) {
        const d = byDigest.get(dg);
        if (d && d.length === 3) out[String(d[1])] = resolve(d[2]);
      }
      return out;
    }
    return node;
  };
  return resolve(payload) as Record<string, unknown>;
}

let caPem: Promise<string> | undefined;
/** The EUDI test CAs as one PEM string, fetched once. */
export function eudiTestCas(fetchImpl: typeof fetch = fetch): Promise<string> {
  caPem ??= Promise.all(EUDI_TEST_CAS.map(async (u) => (await (await fetchImpl(u)).text()).trim()))
    .then((pems) => pems.join('\n'))
    .catch((e) => { caPem = undefined; throw e; });
  return caPem;
}
