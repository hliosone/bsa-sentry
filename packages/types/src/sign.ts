// APDU payload encoders for the three structs 0xMAIN signs: Login, Bind and AgentDelegation
// (security invariant 5 — it signs nothing else, and always with a tap).
//
// The device rebuilds the EIP-712 digest from exactly these raw fields, so each layout is a
// frozen contract. Strings are length-prefixed and bounded, because the device copies them
// into fixed buffers and shows them on a screen.
//
// Every payload starts with the chainId, because it is part of the EIP-712 *domain* and the
// device cannot source it from anywhere else: Login is signed before any policy exists, so
// there is no stored chain id to fall back on.
import type { Hex } from 'viem';
import { concat } from './policy.js';
import { MAX_AGENT_NAME_BYTES, MAX_CLAIMS, MAX_CLAIM_BYTES } from './credentials.js';

/** Enough for any realistic https origin, and still one APDU. */
export const MAX_ORIGIN_BYTES = 64;
export const MAX_VERIFIER_BYTES = 64;

const utf8 = new TextEncoder();

const text = (name: string, value: string, max: number, allowEmpty = false): Uint8Array => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (!allowEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
  const b = utf8.encode(value);
  if (b.length > max) throw new Error(`${name} is ${b.length} bytes, the limit is ${max} bytes`);
  return concat([Uint8Array.of(b.length), b]);
};

const fixed = (name: string, value: Hex, bytes: number): Uint8Array => {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be ${bytes} bytes of hex, got ${value}`);
  }
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
};

const u64 = (name: string, v: bigint): Uint8Array => {
  if (typeof v !== 'bigint') throw new Error(`${name} must be a bigint`);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`${name} does not fit in a u64: ${v}`);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) out[i] = Number((v >> BigInt((7 - i) * 8)) & 0xffn);
  return out;
};

/** `Login { origin, nonce, issuedAt, expiresAt }` — proves control of 0xMAIN to our server. */
export const encodeLoginPayload = (m: { chainId: bigint; origin: string; nonce: Hex; issuedAt: bigint; expiresAt: bigint }) =>
  concat([
    u64('chainId', m.chainId),
    text('origin', m.origin, MAX_ORIGIN_BYTES),
    fixed('nonce', m.nonce, 32),
    u64('issuedAt', m.issuedAt),
    u64('expiresAt', m.expiresAt),
  ]);

/** `Bind { verifier, session, expiresAt }` — ties an EUDIW presentation to 0xMAIN. */
export const encodeBindPayload = (m: { chainId: bigint; verifier: string; session: Hex; expiresAt: bigint }) =>
  concat([
    u64('chainId', m.chainId),
    text('verifier', m.verifier, MAX_VERIFIER_BYTES),
    fixed('session', m.session, 32),
    u64('expiresAt', m.expiresAt),
  ]);

/** `AgentDelegation { agent, agentName, attestation, claims, expiresAt, nonce }`. */
export function encodeDelegationPayload(m: {
  chainId: bigint;
  agent: Hex;
  agentName: string;
  attestation: Hex;
  claims: string[];
  expiresAt: bigint;
  nonce: Hex;
}) {
  if (m.claims.length > MAX_CLAIMS) throw new Error(`a delegation carries at most ${MAX_CLAIMS} claims`);
  return concat([
    u64('chainId', m.chainId),
    fixed('agent', m.agent, 20),
    text('agentName', m.agentName, MAX_AGENT_NAME_BYTES),
    fixed('attestation', m.attestation, 32),
    Uint8Array.of(m.claims.length),
    ...m.claims.map((c, i) => text(`claims[${i}]`, c, MAX_CLAIM_BYTES)),
    u64('expiresAt', m.expiresAt),
    fixed('nonce', m.nonce, 32),
  ]);
}
