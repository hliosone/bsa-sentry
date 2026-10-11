// The agent API: what the MCP tool `x402_fetch` runs.
//
//   GET url -> 402 PAYMENT-REQUIRED -> build an EIP-3009 authorization -> ask the Flex
//   through the relay -> retry with PAYMENT-SIGNATURE -> content + receipt
//
// The server only ever REQUESTS a signature (security invariant 6). It builds the
// authorization, but the device recomputes the digest from those raw fields and decides on
// its own; a refusal comes back with a reason we turn into a sentence the agent can repeat.
import { randomBytes } from 'node:crypto';
import {
  decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader,
} from '@x402/core/http';
import { getAddress, isAddress, type Hex } from 'viem';
import { CLAIM_AGE_OVER_18, type BridgeReason, type PaymentFields } from '@bsa-sentry/types';
import type { RelayAnswer } from '../relay/relay.js';

export type AgentDeps = {
  fetch: typeof fetch;
  relay: { signPayment(account: string, req: { fields: PaymentFields; hint?: string; wantCredentials: boolean }): Promise<RelayAnswer> };
  chainId: number;
  usdc: Hex;
  /** The account's 0xAGENT: the `from` of every authorization. */
  agentAddress(account: string): Promise<Hex>;
  now: () => number;
  /** Injectable for tests; defaults to 32 random bytes. */
  randomNonce?: () => Hex;
};

export type Receipt = { decision: 'approved'; amount: string; payee: Hex; txHash?: Hex; network: string };

export type X402Result =
  | { kind: 'free'; status: number; content: string }
  | { kind: 'paid'; status: number; content: string; receipt: Receipt }
  | { kind: 'refused'; reason: BridgeReason; message: string; amount: string; payee: Hex }
  /** `amount`/`payee` are set when the error happened after the Flex signed. */
  | { kind: 'error'; message: string; amount?: string; payee?: Hex };

/** Never sign for longer than this, whatever the merchant allows. */
const MAX_VALIDITY_S = 300;
const MAX_HINT_BYTES = 24;
const MAX_CONTENT_CHARS = 20_000;

/** USDC base units (6 dp) as a human amount: 3000000 -> "3", 4500000 -> "4.5". */
export function usdcAmount(units: bigint): string {
  const int = units / 1_000_000n;
  const frac = units % 1_000_000n;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

/**
 * What the device shows as "the agent says". Untrusted by construction: it comes from the
 * merchant's own description. Clipped to the device's 24 bytes without splitting a character.
 */
export function hintFor(description: string | undefined, url: string): string {
  let text = description?.trim();
  if (!text) {
    try { text = new URL(url).hostname; } catch { text = ''; }
  }
  const enc = new TextEncoder();
  let out = '';
  for (const ch of text) {
    if (enc.encode(out + ch).length > MAX_HINT_BYTES) break;
    out += ch;
  }
  return out;
}

/** The sentence an agent can repeat to the user, for every way a payment can not happen. */
export function refusalMessage(reason: BridgeReason): string {
  switch (reason) {
    case 'OVER_HARD_MAX':
      return 'Refused by your Flex: OVER_HARD_MAX. This amount is above the absolute ceiling in your rules, so the device refused it without even asking you.';
    case 'USER_REJECTED':
      return 'Refused on your Flex: you refused this payment (or let the 60 s confirmation expire).';
    case 'NO_SESSION':
      return 'Refused by your Flex: NO_SESSION. The agent session is off; start the agent from the BSA Sentry app settings on your Flex.';
    case 'NO_POLICY':
      return 'Refused by your Flex: NO_POLICY. There are no rules on your Flex yet; set your rules on the BSA Sentry website first.';
    case 'WRONG_CHAIN_OR_TOKEN':
      return 'Refused by your Flex: WRONG_CHAIN_OR_TOKEN. Your rules only allow USDC on Arc testnet.';
    case 'INVALID_AMOUNT':
      return 'Refused by your Flex: INVALID_AMOUNT.';
    case 'TIMEOUT':
      return 'Your Flex did not answer in time (timed out). Check the BSA Sentry tab and the device.';
    case 'FLEX_LOCKED':
      return 'Your Flex is locked: unlock your Flex, then try again.';
    case 'APP_CLOSED':
      return 'The BSA Sentry app is not open on your Flex: open BSA Sentry on the device, then try again.';
    case 'DISCONNECTED':
      return 'No device is reachable: open the BSA Sentry tab in Chrome with your Flex plugged in, then try again.';
  }
}

type Requirement = {
  scheme: string; network: string; amount: string; asset: string; payTo: string;
  maxTimeoutSeconds?: number; extra?: { name?: string; version?: string; requires?: unknown[] };
};

export async function x402Fetch(
  account: string,
  req: { url: string; method?: string; body?: string },
  deps: AgentDeps,
): Promise<X402Result> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { kind: 'error', message: `not a valid URL: ${req.url}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'error', message: 'only http and https URLs can be fetched' };
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const init = (headers: Record<string, string> = {}): RequestInit => ({
    method,
    headers: { accept: 'application/json, text/plain, text/html', ...(req.body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(req.body && method !== 'GET' ? { body: req.body } : {}),
    redirect: 'manual',
  });

  let first: Response;
  try {
    first = await deps.fetch(url, init());
  } catch (e) {
    return { kind: 'error', message: `could not reach ${url.host}: ${(e as Error).message}` };
  }
  if (first.status !== 402) {
    return { kind: 'free', status: first.status, content: await readContent(first) };
  }

  // ---------------------------------------------------------------- what is being asked
  const header = first.headers.get('PAYMENT-REQUIRED');
  if (!header) return { kind: 'error', message: `${url.host} answered 402 without a PAYMENT-REQUIRED header` };
  let required: { accepts?: Requirement[]; resource?: { description?: string } };
  try {
    required = decodePaymentRequiredHeader(header) as any;
  } catch {
    return { kind: 'error', message: `${url.host} sent an unreadable PAYMENT-REQUIRED header` };
  }

  const network = `eip155:${deps.chainId}`;
  const offer = (required.accepts ?? []).find(
    (a) => a.scheme === 'exact' && a.network === network && isAddress(a.asset) && getAddress(a.asset) === getAddress(deps.usdc)
      && isAddress(a.payTo) && /^\d+$/.test(String(a.amount)),
  );
  if (!offer) {
    return { kind: 'error', message: `${url.host} does not accept USDC on Arc testnet (${network}); nothing was signed` };
  }

  const value = BigInt(offer.amount);
  const payee = getAddress(offer.payTo).toLowerCase() as Hex;
  const validity = Math.min(MAX_VALIDITY_S, offer.maxTimeoutSeconds ?? MAX_VALIDITY_S);
  const from = await deps.agentAddress(account);
  const fields: PaymentFields = {
    chainId: BigInt(deps.chainId),
    token: deps.usdc.toLowerCase() as Hex,
    to: payee,
    value,
    validAfter: 0n,
    validBefore: BigInt(deps.now() + validity),
    nonce: deps.randomNonce?.() ?? (`0x${randomBytes(32).toString('hex')}` as Hex),
  };
  const wantCredentials = Array.isArray(offer.extra?.requires) && offer.extra!.requires!.includes(CLAIM_AGE_OVER_18);

  // ---------------------------------------------------------------- ask the Flex
  const answer = await deps.relay.signPayment(account, {
    fields,
    hint: hintFor(required.resource?.description, url.toString()),
    wantCredentials,
  });
  if (!answer.ok) {
    return { kind: 'refused', reason: answer.reason, message: refusalMessage(answer.reason), amount: usdcAmount(value), payee };
  }

  // ---------------------------------------------------------------- pay
  const { v, r, s } = answer.signature;
  const paymentPayload = {
    x402Version: 2,
    payload: {
      authorization: {
        from: from.toLowerCase(), to: payee, value: value.toString(), validAfter: '0',
        validBefore: fields.validBefore.toString(), nonce: fields.nonce,
      },
      // x402 and viem use r | s | v.
      signature: `${r}${s.slice(2)}${v.toString(16).padStart(2, '0')}`,
    },
    accepted: offer,
    ...(required.resource ? { resource: required.resource } : {}),
    ...(answer.credentials ? { extensions: { bsaAge: answer.credentials } } : {}),
  };

  const signed = { amount: usdcAmount(value), payee };
  let paid: Response;
  try {
    paid = await deps.fetch(url, init({ 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(paymentPayload as any) }));
  } catch (e) {
    return { kind: 'error', message: `the payment was signed but ${url.host} could not be reached: ${(e as Error).message}`, ...signed };
  }
  if (paid.status === 402 || paid.status >= 400) {
    const why = await readContent(paid);
    return { kind: 'error', message: `${url.host} rejected the signed payment (HTTP ${paid.status})${why ? `: ${why.slice(0, 300)}` : ''}`, ...signed };
  }

  let txHash: Hex | undefined;
  const settle = paid.headers.get('PAYMENT-RESPONSE');
  if (settle) {
    try {
      txHash = ((decodePaymentResponseHeader(settle) as any).transaction || undefined) as Hex | undefined;
    } catch { /* the content was served; the receipt is just missing its hash */ }
  }
  return {
    kind: 'paid',
    status: paid.status,
    content: await readContent(paid),
    receipt: { decision: 'approved', amount: usdcAmount(value), payee, ...(txHash ? { txHash } : {}), network },
  };
}

async function readContent(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n[truncated]` : text;
  } catch {
    return '';
  }
}
