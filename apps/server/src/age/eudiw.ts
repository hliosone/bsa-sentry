// Client for the public EUDI reference verifier backend (OpenID4VP 1.0 + DCQL), ported from
// the team's working integration in ../eudi-verifier-test (see docs/EUDIW.md).
//
// Two deliberate differences from that test page: we request ONLY the age boolean, and we read
// ONLY the age boolean back. The decoded vp_token lives in readAgeOver18's locals and nowhere
// else (security invariant 8). Signatures are not re-checked here: a "Wallet response posted"
// transaction has already been verified by the backend (issuer signature, KB-JWT, nonce).
import { createHash } from 'node:crypto';

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
        // Either spelling satisfies the request; nothing else is asked for.
        claims: [
          { id: 'age_18', path: ['age_equal_or_over', '18'] },
          { id: 'age_over_18', path: ['age_over_18'] },
        ],
        claim_sets: [['age_18'], ['age_over_18']],
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
 * Reads the over-18 boolean out of a verified vp_token, and nothing else.
 * `age_equal_or_over.18` (current PID rulebook) or `age_over_18`; it must be exactly `true`.
 */
export function readAgeOver18(vpToken: unknown): boolean {
  try {
    for (const presentations of Object.values((vpToken ?? {}) as Record<string, unknown>)) {
      for (const p of ([] as unknown[]).concat(presentations)) {
        if (typeof p !== 'string' || !p.includes('~')) continue;
        const claims = resolveSdJwt(p);
        const nested = (claims.age_equal_or_over as Record<string, unknown> | undefined)?.['18'];
        if (nested === true || claims.age_over_18 === true) return true;
      }
    }
  } catch {
    /* malformed: treated as "not proven" */
  }
  return false;
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
