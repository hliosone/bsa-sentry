// The agent API: what `x402_fetch` runs.
//
// GET -> 402 -> build the authorization -> ask the Flex through the relay -> retry with
// PAYMENT-SIGNATURE -> content + receipt. The server only ever REQUESTS the signature; a
// refusal from the device is reported to the agent in words it can repeat to the user.
import { describe, expect, it, vi } from 'vitest';
import {
  decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
} from '@x402/core/http';
import { x402Fetch, hintFor, type AgentDeps } from '../src/agent/x402-client.js';

const CHAIN = 5042002;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const AGENT = '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' as const;
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;
const NOW = 1_760_000_000;
const sig = { v: 28 as const, r: `0x${'aa'.repeat(32)}` as const, s: `0x${'bb'.repeat(32)}` as const };

const requirement = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: `eip155:${CHAIN}`, amount: '3000000', asset: USDC, payTo: CAFE,
  maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' }, ...over,
});

const paymentRequired = (accepts = [requirement()], description = 'Un cafe chez Cafe Sat') => ({
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'http://merchants/cafe', description, mimeType: 'application/json' },
  accepts,
});

/** A merchant that answers 402 first, then 200 once paid. Records what it was sent. */
function merchant(opts: { required?: ReturnType<typeof paymentRequired>; paidStatus?: number; free?: boolean; rejectReason?: string } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const headers = new Headers(init?.headers);
    if (opts.free) return new Response(JSON.stringify({ menu: 'free' }), { status: 200 });
    if (!headers.get('PAYMENT-SIGNATURE')) {
      return new Response(JSON.stringify({}), {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader((opts.required ?? paymentRequired()) as any) },
      });
    }
    if (opts.rejectReason) {
      // What @x402/express 2.28 does when the facilitator says no: a fresh 402 whose
      // PAYMENT-REQUIRED header carries the facilitator's reason in `error`; the body is empty.
      return new Response('{}', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ ...(opts.required ?? paymentRequired()), error: opts.rejectReason } as any) },
      });
    }
    return new Response(JSON.stringify({ coffee: 'espresso' }), {
      status: opts.paidStatus ?? 200,
      headers: {
        'content-type': 'application/json',
        'PAYMENT-RESPONSE': encodePaymentResponseHeader({
          success: true, transaction: `0x${'cd'.repeat(32)}`, network: `eip155:${CHAIN}`, payer: AGENT,
        } as any),
      },
    });
  });
  return { fetchImpl, calls };
}

function deps(over: Partial<AgentDeps> = {}, m = merchant()): AgentDeps & { m: typeof m } {
  return {
    m,
    fetch: m.fetchImpl as unknown as typeof fetch,
    relay: { signPayment: vi.fn(async () => ({ ok: true as const, signature: sig })) },
    chainId: CHAIN,
    usdc: USDC,
    agentAddress: async () => AGENT,
    now: () => NOW,
    randomNonce: () => `0x${'42'.repeat(32)}`,
    ...over,
  };
}

describe('a free page', () => {
  it('returns the content and never asks the device anything', async () => {
    const d = deps({}, merchant({ free: true }));
    const r = await x402Fetch('alice', { url: 'http://merchants/promo' }, d);
    expect(r).toMatchObject({ kind: 'free', status: 200 });
    expect(r.kind === 'free' && r.content).toContain('free');
    expect(d.relay.signPayment).not.toHaveBeenCalled();
  });
});

describe('a paid page', () => {
  it('builds the authorization the device will sign', async () => {
    const d = deps();
    await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
    expect(d.relay.signPayment).toHaveBeenCalledWith('alice', {
      fields: {
        chainId: 5042002n, token: USDC, to: CAFE, value: 3_000_000n,
        validAfter: 0n, validBefore: BigInt(NOW + 300), nonce: `0x${'42'.repeat(32)}`,
      },
      hint: 'Un cafe chez Cafe Sat',
      wantCredentials: false,
    });
  });

  it('retries with a PAYMENT-SIGNATURE carrying the authorization and an r|s|v signature', async () => {
    const d = deps();
    await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
    const retry = d.m.calls[1]!;
    const header = new Headers(retry.init?.headers).get('PAYMENT-SIGNATURE')!;
    const payload = decodePaymentSignatureHeader(header) as any;
    expect(payload.x402Version).toBe(2);
    expect(payload.payload.authorization).toEqual({
      from: AGENT, to: CAFE, value: '3000000', validAfter: '0',
      validBefore: String(NOW + 300), nonce: `0x${'42'.repeat(32)}`,
    });
    // viem / x402 order: r | s | v
    expect(payload.payload.signature).toBe(`0x${'aa'.repeat(32)}${'bb'.repeat(32)}1c`);
    expect(payload.accepted).toMatchObject({ payTo: CAFE, amount: '3000000' });
  });

  it('returns the content and a receipt with the transaction hash', async () => {
    const r = await x402Fetch('alice', { url: 'http://merchants/cafe' }, deps());
    expect(r).toMatchObject({
      kind: 'paid', status: 200,
      receipt: { decision: 'approved', amount: '3', payee: CAFE, txHash: `0x${'cd'.repeat(32)}` },
    });
    expect(r.kind === 'paid' && r.content).toContain('espresso');
  });

  it('never lets the validity window exceed what the merchant allows', async () => {
    const d = deps({}, merchant({ required: paymentRequired([requirement({ maxTimeoutSeconds: 60 })]) }));
    await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
    const call = (d.relay.signPayment as any).mock.calls[0][1];
    expect(call.fields.validBefore).toBe(BigInt(NOW + 60));
  });

  it('uses a fresh random nonce by default', async () => {
    const d = deps({ randomNonce: undefined });
    await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
    await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
    const n1 = (d.relay.signPayment as any).mock.calls[0][1].fields.nonce;
    const n2 = (d.relay.signPayment as any).mock.calls[1][1].fields.nonce;
    expect(n1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(n1).not.toBe(n2);
  });
});

describe('choosing what to pay', () => {
  it('only accepts an offer on our chain, in USDC, with the exact scheme', async () => {
    const offers = [
      requirement({ network: 'eip155:84532' }),
      requirement({ asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' }),
      requirement({ scheme: 'upto' }),
      requirement({ amount: '4500000' }),
    ];
    const d = deps({}, merchant({ required: paymentRequired(offers) }));
    await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
    expect((d.relay.signPayment as any).mock.calls[0][1].fields.value).toBe(4_500_000n);
  });

  it('reports a clear error when no offer is payable, without asking the device', async () => {
    const d = deps({}, merchant({ required: paymentRequired([requirement({ network: 'eip155:1' })]) }));
    const r = await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
    expect(r).toMatchObject({ kind: 'error' });
    expect(r.kind === 'error' && r.message).toMatch(/Arc|USDC|network/i);
    expect(d.relay.signPayment).not.toHaveBeenCalled();
  });
});

describe('18+', () => {
  const ageRequired = () => paymentRequired([requirement({ amount: '4500000', extra: { name: 'USDC', version: '2', requires: ['age_over_18'] } })]);
  const credentials = {
    attestation: '0xaa' as const, attestationSig: `0x${'bb'.repeat(65)}` as const,
    delegation: '0xcc' as const, delegationSig: `0x${'dd'.repeat(65)}` as const,
  };

  it('asks the tab for credentials only when the merchant requires 18+', async () => {
    const d = deps({ relay: { signPayment: vi.fn(async () => ({ ok: true as const, signature: sig, credentials })) } },
      merchant({ required: ageRequired() }));
    await x402Fetch('alice', { url: 'http://merchants/wine' }, d);
    expect((d.relay.signPayment as any).mock.calls[0][1].wantCredentials).toBe(true);
  });

  it('attaches them as extensions.bsaAge in the payment', async () => {
    const d = deps({ relay: { signPayment: vi.fn(async () => ({ ok: true as const, signature: sig, credentials })) } },
      merchant({ required: ageRequired() }));
    await x402Fetch('alice', { url: 'http://merchants/wine' }, d);
    const payload = decodePaymentSignatureHeader(new Headers(d.m.calls[1]!.init?.headers).get('PAYMENT-SIGNATURE')!) as any;
    expect(payload.extensions.bsaAge).toEqual(credentials);
  });

  it('asks for credentials for a nationality requirement too, and names it when they are missing', async () => {
    const presale = () => paymentRequired([requirement({ amount: '5000000', extra: { name: 'USDC', version: '2', requires: ['jurisdiction_not:US'] } })]);
    const d = deps({ relay: { signPayment: vi.fn(async () => ({ ok: true as const, signature: sig, credentials })) } }, merchant({ required: presale() }));
    await x402Fetch('alice', { url: 'http://merchants/presale' }, d);
    expect((d.relay.signPayment as any).mock.calls[0][1].wantCredentials).toBe(true);

    const r = await x402Fetch('alice', { url: 'http://merchants/presale' }, deps({}, merchant({ required: presale(), rejectReason: 'AGE_PROOF_REQUIRED' })));
    expect(r.kind === 'error' && r.message).toMatch(/not a US person/);
    expect(r.kind === 'error' && r.message).toMatch(/Agent identity/);
  });

  it('still sends the payment without credentials, and lets the facilitator refuse it', async () => {
    // The server must not decide on the facilitator's behalf: it forwards what it has.
    const d = deps({}, merchant({ required: ageRequired(), paidStatus: 402 }));
    const r = await x402Fetch('alice', { url: 'http://merchants/wine' }, d);
    const payload = decodePaymentSignatureHeader(new Headers(d.m.calls[1]!.init?.headers).get('PAYMENT-SIGNATURE')!) as any;
    expect(payload.extensions?.bsaAge).toBeUndefined();
    expect(r.kind).toBe('error');
  });
});

describe('refusals and failures, in words the agent can repeat', () => {
  const cases: [string, RegExp][] = [
    ['OVER_HARD_MAX', /refused by your Flex.*OVER_HARD_MAX/i],
    ['USER_REJECTED', /refused.*on your Flex|you refused/i],
    ['NO_SESSION', /agent session|start.*agent/i],
    ['NO_POLICY', /no rules|set.*rules/i],
    ['FLEX_LOCKED', /unlock your Flex/i],
    ['APP_CLOSED', /open.*BSA Sentry/i],
    ['DISCONNECTED', /open the BSA Sentry tab/i],
    ['TIMEOUT', /did not answer|timed out/i],
  ];
  for (const [reason, pattern] of cases) {
    it(`${reason}`, async () => {
      const d = deps({ relay: { signPayment: vi.fn(async () => ({ ok: false as const, reason: reason as any })) } });
      const r = await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
      expect(r).toMatchObject({ kind: 'refused', reason, amount: '3', payee: CAFE });
      expect(r.kind === 'refused' && r.message).toMatch(pattern);
      // Refused means the merchant is never retried: nothing was signed.
      expect(d.m.calls).toHaveLength(1);
    });
  }

  it('reports a merchant that rejects a signed payment, with what was signed', async () => {
    const r = await x402Fetch('alice', { url: 'http://merchants/cafe' }, deps({}, merchant({ paidStatus: 402 })));
    // The dashboard needs the amount and payee to mark the signed request as failed.
    expect(r).toMatchObject({ kind: 'error', amount: '3', payee: CAFE });
  });

  it('reports the facilitator\'s reason when the merchant rejects the signed payment', async () => {
    const r = await x402Fetch('alice', { url: 'http://merchants/wine' }, deps({}, merchant({ rejectReason: 'AGE_PROOF_REQUIRED' })));
    expect(r).toMatchObject({ kind: 'error', amount: '3', payee: CAFE });
    expect(r.kind === 'error' && r.message).toMatch(/AGE_PROOF_REQUIRED/);
    // And it tells the agent what to do about it.
    expect(r.kind === 'error' && r.message).toMatch(/Agent identity/);
  });

  it('says plainly when the user revoked the agent\'s rights', async () => {
    const r = await x402Fetch('alice', { url: 'http://merchants/wine' }, deps({}, merchant({ rejectReason: 'DELEGATION_REVOKED' })));
    expect(r.kind === 'error' && r.message).toMatch(/revoked/i);
  });

  it('reports an unreachable merchant', async () => {
    const d = deps({ fetch: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any });
    const r = await x402Fetch('alice', { url: 'http://merchants/cafe' }, d);
    expect(r).toMatchObject({ kind: 'error' });
    expect(r.kind === 'error' && r.message).toMatch(/ECONNREFUSED|reach/i);
  });

  it('refuses a non-http URL outright', async () => {
    const r = await x402Fetch('alice', { url: 'file:///etc/passwd' }, deps());
    expect(r).toMatchObject({ kind: 'error' });
  });
});

describe('the hint', () => {
  it('is clipped to the 24 bytes the device accepts', () => {
    expect(new TextEncoder().encode(hintFor('A very long merchant description that goes on', 'x')).length).toBeLessThanOrEqual(24);
  });

  it('never splits a multi-byte character', () => {
    const h = hintFor('Café Zürich très très long nom', 'x');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(h))).not.toThrow();
    expect(new TextEncoder().encode(h).length).toBeLessThanOrEqual(24);
  });

  it('falls back to the host name', () => {
    expect(hintFor(undefined, 'http://cafe.example/menu')).toBe('cafe.example');
  });
});
