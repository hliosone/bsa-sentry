// Binary codec for the policy and the device state.
//
// This is the wire format device-app/core parses in no_std Rust, so it is deliberately dull:
// big-endian, fixed offsets, length-prefixed labels, and every malformed input is rejected
// rather than tolerated. A decoder that silently ignores trailing bytes would let a host
// smuggle a 9th payee past an on-device review.
//
// Policy, big-endian:
//   0      u8    version (= 1)
//   1      u8    flags, bit0 = active (no other bit may be set)
//   2..10  u64   chainId
//   10..30 [20]  token
//   30..38 u64   autoMax        amounts are USDC base units (6 dp)
//   38..46 u64   hardMax
//   46..54 u64   budget
//   54..56 u16   maxCount
//   56     u8    payeeCount (0..8)
//   57..         payeeCount x { [20] address, u8 labelLen (0..16), [labelLen] label (UTF-8) }
// 57 bytes with no payees, 353 with 8 full-label payees - both well inside the 1024-byte
// device reassembly buffer.
import type { Hex } from 'viem';

export const POLICY_WIRE_VERSION = 1;
export const STATE_WIRE_VERSION = 1;
export const MAX_PAYEES = 8;
/** The device stores labels as bytes, so the limit is 16 **bytes** of UTF-8, not 16 codepoints. */
export const MAX_LABEL_BYTES = 16;
export const POLICY_WIRE_MIN_LEN = 57;

export type Payee = { address: Hex; label: string };

export type Policy = {
  active: boolean;
  chainId: bigint;
  token: Hex;
  autoMax: bigint;
  hardMax: bigint;
  budget: bigint;
  maxCount: number;
  payees: Payee[];
};

export type DeviceState = {
  sessionArmed: boolean;
  hasCredentials: boolean;
  spent: bigint;
  count: number;
  /** The last payment the device signed, for the home screen. `null` on a fresh device. */
  lastPayment: { label: string; value: bigint } | null;
  policy: Policy;
};

const utf8 = new TextEncoder();
/** `fatal` so an invalid byte sequence throws instead of yielding U+FFFD. */
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

const u64 = (name: string, v: bigint): Uint8Array => {
  if (typeof v !== 'bigint') throw new Error(`${name} must be a bigint`);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`${name} does not fit in a u64: ${v}`);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) out[i] = Number((v >> BigInt((7 - i) * 8)) & 0xffn);
  return out;
};

const u16 = (name: string, v: number): Uint8Array => {
  if (!Number.isInteger(v)) throw new Error(`${name} must be an integer`);
  if (v < 0 || v > 0xffff) throw new Error(`${name} does not fit in a u16: ${v}`);
  return Uint8Array.of((v >> 8) & 0xff, v & 0xff);
};

const addr20 = (name: string, a: Hex): Uint8Array => {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`${name} must be 20 bytes of hex: ${a}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(a.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
};

const label = (l: string): Uint8Array => {
  if (typeof l !== 'string') throw new Error('label must be a string');
  const bytes = utf8.encode(l);
  if (bytes.length > MAX_LABEL_BYTES) throw new Error(`label "${l}" is ${bytes.length} bytes, the limit is ${MAX_LABEL_BYTES} bytes`);
  return bytes;
};

/** Addresses are lower-cased on decode so the device's byte comparison and ours agree. */
const hex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

const readU64 = (b: Uint8Array, at: number): bigint => {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[at + i]!);
  return v;
};
const readU16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;

export function encodePolicy(p: Policy): Uint8Array {
  if (p.payees.length > MAX_PAYEES) throw new Error(`a policy holds at most ${MAX_PAYEES} payees, got ${p.payees.length}`);
  if (p.autoMax > p.hardMax) throw new Error(`autoMax (${p.autoMax}) must not exceed hardMax (${p.hardMax})`);

  const seen = new Set<string>();
  for (const { address } of p.payees) {
    const key = address.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate payee address ${address}`);
    seen.add(key);
  }

  const parts: Uint8Array[] = [
    Uint8Array.of(POLICY_WIRE_VERSION, p.active ? 1 : 0),
    u64('chainId', p.chainId),
    addr20('token', p.token),
    u64('autoMax', p.autoMax),
    u64('hardMax', p.hardMax),
    u64('budget', p.budget),
    u16('maxCount', p.maxCount),
    Uint8Array.of(p.payees.length),
  ];
  for (const payee of p.payees) {
    const l = label(payee.label);
    parts.push(addr20('payee address', payee.address), Uint8Array.of(l.length), l);
  }
  return concat(parts);
}

/** Decodes a policy and asserts it consumed the whole buffer. */
export function decodePolicy(b: Uint8Array): Policy {
  const { policy, read } = readPolicy(b, 0);
  if (read !== b.length) throw new Error(`trailing bytes after the policy: ${b.length - read}`);
  return policy;
}

function readPolicy(b: Uint8Array, start: number): { policy: Policy; read: number } {
  if (b.length - start < POLICY_WIRE_MIN_LEN) throw new Error(`policy too short: ${b.length - start} bytes, minimum ${POLICY_WIRE_MIN_LEN}`);
  if (b[start] !== POLICY_WIRE_VERSION) throw new Error(`unsupported policy wire version ${b[start]}`);
  const flags = b[start + 1]!;
  if (flags & ~0x01) throw new Error(`unknown policy flag bits set: 0x${flags.toString(16)}`);

  const payeeCount = b[start + 56]!;
  if (payeeCount > MAX_PAYEES) throw new Error(`policy declares ${payeeCount} payees, at most ${MAX_PAYEES} are allowed`);

  const payees: Payee[] = [];
  let at = start + 57;
  for (let i = 0; i < payeeCount; i++) {
    if (at + 21 > b.length) throw new Error(`truncated payee ${i}`);
    const address = hex(b.subarray(at, at + 20));
    const labelLen = b[at + 20]!;
    if (labelLen > MAX_LABEL_BYTES) throw new Error(`payee ${i} label length ${labelLen} exceeds ${MAX_LABEL_BYTES}`);
    at += 21;
    if (at + labelLen > b.length) throw new Error(`truncated payee ${i} label`);
    let text: string;
    try {
      text = utf8Strict.decode(b.subarray(at, at + labelLen));
    } catch {
      throw new Error(`payee ${i} label is not valid UTF-8`);
    }
    at += labelLen;
    payees.push({ address, label: text });
  }

  return {
    policy: {
      active: (flags & 0x01) !== 0,
      chainId: readU64(b, start + 2),
      token: hex(b.subarray(start + 10, start + 30)),
      autoMax: readU64(b, start + 30),
      hardMax: readU64(b, start + 38),
      budget: readU64(b, start + 46),
      maxCount: readU16(b, start + 54),
      payees,
    },
    read: at,
  };
}

// State, big-endian:
//   0      u8   version (= 1)
//   1      u8   flags, bit0 = sessionArmed, bit1 = hasCredentials
//   2..10  u64  spent
//   10..12 u16  count
//   12..20 u64  lastPayment value (0 = none)
//   20     u8   lastPayment label length (0..16)
//   21..        lastPayment label
//   then        the policy, in the format above
const STATE_HEADER_LEN = 21;

export function encodeState(s: DeviceState): Uint8Array {
  const last = s.lastPayment;
  const l = last ? label(last.label) : new Uint8Array(0);
  if (last && last.value === 0n) throw new Error('a recorded last payment cannot have value 0; use null');
  return concat([
    Uint8Array.of(STATE_WIRE_VERSION, (s.sessionArmed ? 0x01 : 0) | (s.hasCredentials ? 0x02 : 0)),
    u64('spent', s.spent),
    u16('count', s.count),
    u64('lastPayment value', last ? last.value : 0n),
    Uint8Array.of(l.length),
    l,
    encodePolicy(s.policy),
  ]);
}

export function decodeState(b: Uint8Array): DeviceState {
  if (b.length < STATE_HEADER_LEN) throw new Error(`state too short: ${b.length} bytes`);
  if (b[0] !== STATE_WIRE_VERSION) throw new Error(`unsupported state wire version ${b[0]}`);
  const flags = b[1]!;
  if (flags & ~0x03) throw new Error(`unknown state flag bits set: 0x${flags.toString(16)}`);

  const value = readU64(b, 12);
  const labelLen = b[20]!;
  if (labelLen > MAX_LABEL_BYTES) throw new Error(`last payment label length ${labelLen} exceeds ${MAX_LABEL_BYTES}`);
  if (STATE_HEADER_LEN + labelLen > b.length) throw new Error('truncated last payment label');
  let text: string;
  try {
    text = utf8Strict.decode(b.subarray(STATE_HEADER_LEN, STATE_HEADER_LEN + labelLen));
  } catch {
    throw new Error('last payment label is not valid UTF-8');
  }

  const { policy, read } = readPolicy(b, STATE_HEADER_LEN + labelLen);
  if (read !== b.length) throw new Error(`trailing bytes after the state: ${b.length - read}`);

  return {
    sessionArmed: (flags & 0x01) !== 0,
    hasCredentials: (flags & 0x02) !== 0,
    spent: readU64(b, 2),
    count: readU16(b, 10),
    lastPayment: value === 0n ? null : { label: text, value },
    policy,
  };
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
