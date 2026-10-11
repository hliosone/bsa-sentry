// Binary codec for the 18+ credential bundle (attestation + delegation, each with its
// signature), used by STORE_CREDENTIALS, GET_CREDENTIALS and RESTORE.
//
// The codec is deliberately agnostic about *meaning*: it decodes faithfully, and the device
// then checks on its own that the delegation is signed by its own 0xMAIN and targets its own
// 0xAGENT. Keeping those checks out of the codec is what makes them testable in isolation.
//
// Layout, big-endian:
//   0      u8   version (= 1)
//   1      u8   flags (reserved, must be 0)
//   2..10  u64  chainId  - part of both EIP-712 domains, so the device can rebuild the
//                          digests and check the delegation really came from its own 0xMAIN
//   attestation: [20] subject, u8 claimLen + claim, u64 issuedAt, u64 expiresAt, [32] evidence
//   [65]   attestationSig: v ‖ r ‖ s
//   delegation:  [20] agent, u8 nameLen + name, [32] attestation,
//                u8 claimCount + claimCount x (u8 len + claim), u64 expiresAt, [32] nonce
//   [65]   delegationSig: v ‖ r ‖ s
import type { Hex } from 'viem';
import { concat } from './policy.js';

export const CREDENTIALS_WIRE_VERSION = 1;
export const MAX_CLAIMS = 4;
export const MAX_CLAIM_BYTES = 32;
export const MAX_AGENT_NAME_BYTES = 24;
export const SIG_LEN = 65;

export type AgeAttestation = {
  subject: Hex;
  claim: string;
  issuedAt: bigint;
  expiresAt: bigint;
  evidence: Hex;
};

export type AgentDelegation = {
  agent: Hex;
  agentName: string;
  /** keccak256 of the AgeAttestation struct it authorises the agent to present. */
  attestation: Hex;
  claims: string[];
  expiresAt: bigint;
  nonce: Hex;
};

export type Credentials = {
  /** The chain whose EIP-712 domain both signatures were made under. */
  chainId: bigint;
  attestation: AgeAttestation;
  attestationSig: Hex;
  delegation: AgentDelegation;
  delegationSig: Hex;
};

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

const fixedHex = (name: string, value: Hex, bytes: number): Uint8Array => {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be ${bytes} bytes of hex, got ${value}`);
  }
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
};

const signature = (name: string, value: Hex): Uint8Array => {
  const b = fixedHex(name, value, SIG_LEN);
  if (b[0] !== 27 && b[0] !== 28) throw new Error(`${name} has an invalid recovery byte ${b[0]}; expected 27 or 28`);
  return b;
};

const u64 = (name: string, v: bigint): Uint8Array => {
  if (typeof v !== 'bigint') throw new Error(`${name} must be a bigint`);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`${name} does not fit in a u64: ${v}`);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) out[i] = Number((v >> BigInt((7 - i) * 8)) & 0xffn);
  return out;
};

const text = (name: string, value: string, max: number, allowEmpty: boolean): Uint8Array => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  if (!allowEmpty && value.length === 0) throw new Error(`${name} must not be empty`);
  const b = utf8.encode(value);
  if (b.length > max) throw new Error(`${name} is ${b.length} bytes, the limit is ${max} bytes`);
  return concat([Uint8Array.of(b.length), b]);
};

const hex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

/** The attestation as it appears inside the bundle (and in the relay's `attestation` field). */
export function encodeAttestation(a: AgeAttestation): Uint8Array {
  return concat([
    fixedHex('attestation.subject', a.subject, 20),
    text('attestation.claim', a.claim, MAX_CLAIM_BYTES, false),
    u64('attestation.issuedAt', a.issuedAt),
    u64('attestation.expiresAt', a.expiresAt),
    fixedHex('attestation.evidence', a.evidence, 32),
  ]);
}

/** The delegation as it appears inside the bundle (and in the relay's `delegation` field). */
export function encodeDelegation(d: AgentDelegation): Uint8Array {
  if (d.claims.length > MAX_CLAIMS) {
    throw new Error(`a delegation carries at most ${MAX_CLAIMS} claims, got ${d.claims.length}`);
  }
  return concat([
    fixedHex('delegation.agent', d.agent, 20),
    text('delegation.agentName', d.agentName, MAX_AGENT_NAME_BYTES, false),
    fixedHex('delegation.attestation', d.attestation, 32),
    Uint8Array.of(d.claims.length),
    ...d.claims.map((claim, i) => text(`delegation.claims[${i}]`, claim, MAX_CLAIM_BYTES, false)),
    u64('delegation.expiresAt', d.expiresAt),
    fixedHex('delegation.nonce', d.nonce, 32),
  ]);
}

export function encodeCredentials(c: Credentials): Uint8Array {
  return concat([
    Uint8Array.of(CREDENTIALS_WIRE_VERSION, 0),
    u64('chainId', c.chainId),
    encodeAttestation(c.attestation),
    signature('attestationSig', c.attestationSig),
    encodeDelegation(c.delegation),
    signature('delegationSig', c.delegationSig),
  ]);
}

/** Minimum: header + both structs with empty strings and no claims. */
const MIN_LEN = 2 + 8 + (20 + 1 + 8 + 8 + 32) + SIG_LEN + (20 + 1 + 32 + 1 + 8 + 32) + SIG_LEN;

class Cursor {
  at = 0;
  constructor(private readonly b: Uint8Array) {}
  take(n: number, what: string): Uint8Array {
    if (this.at + n > this.b.length) throw new Error(`truncated credentials: ${what}`);
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  text(what: string, max: number): string {
    const len = this.take(1, `${what} length`)[0]!;
    if (len > max) throw new Error(`${what} length ${len} exceeds ${max}`);
    const raw = this.take(len, what);
    try {
      return utf8Strict.decode(raw);
    } catch {
      throw new Error(`${what} is not valid UTF-8`);
    }
  }
  u64(what: string): bigint {
    let v = 0n;
    for (const byte of this.take(8, what)) v = (v << 8n) | BigInt(byte);
    return v;
  }
  done(what: string) {
    if (this.at !== this.b.length) throw new Error(`trailing bytes after the ${what}: ${this.b.length - this.at}`);
  }
}

function readAttestation(c: Cursor): AgeAttestation {
  return {
    subject: hex(c.take(20, 'attestation.subject')),
    claim: c.text('attestation.claim', MAX_CLAIM_BYTES),
    issuedAt: c.u64('attestation.issuedAt'),
    expiresAt: c.u64('attestation.expiresAt'),
    evidence: hex(c.take(32, 'attestation.evidence')),
  };
}

function readDelegation(c: Cursor): AgentDelegation {
  const agent = hex(c.take(20, 'delegation.agent'));
  const agentName = c.text('delegation.agentName', MAX_AGENT_NAME_BYTES);
  const attestation = hex(c.take(32, 'delegation.attestation'));
  const claimCount = c.take(1, 'delegation.claimCount')[0]!;
  if (claimCount > MAX_CLAIMS) throw new Error(`delegation declares ${claimCount} claims, at most ${MAX_CLAIMS} are allowed`);
  const claims: string[] = [];
  for (let i = 0; i < claimCount; i++) claims.push(c.text(`delegation.claims[${i}]`, MAX_CLAIM_BYTES));
  return { agent, agentName, attestation, claims, expiresAt: c.u64('delegation.expiresAt'), nonce: hex(c.take(32, 'delegation.nonce')) };
}

export function decodeAttestation(b: Uint8Array): AgeAttestation {
  const c = new Cursor(b);
  const a = readAttestation(c);
  c.done('attestation');
  return a;
}

export function decodeDelegation(b: Uint8Array): AgentDelegation {
  const c = new Cursor(b);
  const d = readDelegation(c);
  c.done('delegation');
  return d;
}

export function decodeCredentials(b: Uint8Array): Credentials {
  if (b.length < MIN_LEN) throw new Error(`credentials too short: ${b.length} bytes, minimum ${MIN_LEN}`);
  if (b[0] !== CREDENTIALS_WIRE_VERSION) throw new Error(`unsupported credentials wire version ${b[0]}`);
  if (b[1] !== 0) throw new Error(`unknown credentials flag bits set: 0x${b[1]!.toString(16)}`);
  const c = new Cursor(b);
  c.take(2, 'header');
  const chainId = c.u64('chainId');
  const attestation = readAttestation(c);
  const attestationSig = hex(c.take(SIG_LEN, 'attestationSig'));
  const delegation = readDelegation(c);
  const delegationSig = hex(c.take(SIG_LEN, 'delegationSig'));
  c.done('credentials');
  return { chainId, attestation, attestationSig, delegation, delegationSig };
}

// ------------------------------------------------------------------ relay form

/** The four hex fields of the relay message's `credentials` (spec §5.5). */
export type CredentialParts = {
  attestation: Hex;
  attestationSig: Hex;
  delegation: Hex;
  delegationSig: Hex;
};

const unhex = (h: Hex, what: string): Uint8Array => {
  if (typeof h !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`${what} must be hex`);
  return Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
};

/** Bundle -> relay fields. The bridge does this with what the device returns. */
export function splitCredentials(c: Credentials): CredentialParts {
  return {
    attestation: hex(encodeAttestation(c.attestation)),
    attestationSig: hex(signature('attestationSig', c.attestationSig)),
    delegation: hex(encodeDelegation(c.delegation)),
    delegationSig: hex(signature('delegationSig', c.delegationSig)),
  };
}

/**
 * Relay fields -> bundle. The chain id is not on the wire: the facilitator supplies its own,
 * because a signature made under any other chain's domain must not verify anyway.
 */
export function joinCredentials(p: CredentialParts, chainId: bigint): Credentials {
  return {
    chainId,
    attestation: decodeAttestation(unhex(p.attestation, 'attestation')),
    attestationSig: hex(signature('attestationSig', hex(unhex(p.attestationSig, 'attestationSig')))),
    delegation: decodeDelegation(unhex(p.delegation, 'delegation')),
    delegationSig: hex(signature('delegationSig', hex(unhex(p.delegationSig, 'delegationSig')))),
  };
}
