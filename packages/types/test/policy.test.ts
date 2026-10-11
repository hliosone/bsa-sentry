// Policy / state binary codec contract tests.
// This is the exact byte layout device-app/core parses in no_std Rust, so the tests pin
// offsets and reject every malformed input rather than tolerating it.
import { describe, expect, it } from 'vitest';
import { bytesToHex } from 'viem';
import {
  MAX_PAYEES, MAX_LABEL_BYTES, POLICY_WIRE_VERSION, POLICY_WIRE_MIN_LEN,
  encodePolicy, decodePolicy, encodeState, decodeState, type Policy, type DeviceState,
} from '../src/index.js';

const TOKEN = '0x3600000000000000000000000000000000000000' as const;
const A = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(20)}` as const;

/** The demo policy from the spec: auto 5, hard 50, budget 20, 10 payments, café/cave/resto. */
const demo = (): Policy => ({
  active: true,
  chainId: 5042002n,
  token: TOKEN,
  autoMax: 5_000_000n,
  hardMax: 50_000_000n,
  budget: 20_000_000n,
  maxCount: 10,
  payees: [
    { address: A(0x11), label: 'Cafe Sat' },
    { address: A(0x22), label: 'Cave du Coin' },
    { address: A(0x33), label: 'Resto' },
  ],
});

describe('policy codec round trip', () => {
  it('round-trips the demo policy', () => {
    expect(decodePolicy(encodePolicy(demo()))).toEqual(demo());
  });

  it('round-trips with zero payees', () => {
    const p = { ...demo(), payees: [] };
    expect(decodePolicy(encodePolicy(p))).toEqual(p);
  });

  it('round-trips with the maximum 8 payees and 16-byte labels', () => {
    const p: Policy = { ...demo(), payees: Array.from({ length: MAX_PAYEES }, (_, i) => ({ address: A(i + 1), label: 'x'.repeat(MAX_LABEL_BYTES) })) };
    expect(decodePolicy(encodePolicy(p))).toEqual(p);
  });

  it('round-trips an inactive policy', () => {
    const p = { ...demo(), active: false };
    expect(decodePolicy(encodePolicy(p))).toEqual(p);
  });

  it('round-trips an empty label', () => {
    const p: Policy = { ...demo(), payees: [{ address: A(0x11), label: '' }] };
    expect(decodePolicy(encodePolicy(p))).toEqual(p);
  });

  it('round-trips the u64 and u16 maxima', () => {
    const p: Policy = { ...demo(), chainId: 2n ** 64n - 1n, autoMax: 2n ** 64n - 1n, hardMax: 2n ** 64n - 1n, budget: 2n ** 64n - 1n, maxCount: 0xffff };
    expect(decodePolicy(encodePolicy(p))).toEqual(p);
  });

  it('round-trips a multi-byte UTF-8 label within the byte budget', () => {
    const p: Policy = { ...demo(), payees: [{ address: A(0x11), label: 'Café Zürich' }] }; // 13 bytes, 11 chars
    expect(decodePolicy(encodePolicy(p))).toEqual(p);
  });

  it('normalises address case on decode so comparisons are byte-exact', () => {
    const p: Policy = { ...demo(), payees: [{ address: '0xAa6aBf8F8c5F003A69D26d12d5a625Da77e2D9bF', label: 'mixed' }] };
    const back = decodePolicy(encodePolicy(p));
    expect(back.payees[0]!.address).toBe('0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf');
    expect(back.token).toBe(TOKEN.toLowerCase());
  });
});

describe('policy wire layout is pinned', () => {
  const bytes = encodePolicy(demo());

  it('starts with the version byte and the active flag', () => {
    expect(bytes[0]).toBe(POLICY_WIRE_VERSION);
    expect(bytes[1]).toBe(1);
    expect(encodePolicy({ ...demo(), active: false })[1]).toBe(0);
  });

  it('puts chainId big-endian at offset 2 and the token at 10', () => {
    expect(bytesToHex(bytes.slice(2, 10))).toBe('0x00000000004cef52'); // 5042002
    expect(bytesToHex(bytes.slice(10, 30))).toBe(TOKEN.toLowerCase());
  });

  it('puts autoMax / hardMax / budget / maxCount at 30 / 38 / 46 / 54', () => {
    expect(bytesToHex(bytes.slice(30, 38))).toBe('0x00000000004c4b40'); // 5_000_000
    expect(bytesToHex(bytes.slice(38, 46))).toBe('0x0000000002faf080'); // 50_000_000
    expect(bytesToHex(bytes.slice(46, 54))).toBe('0x0000000001312d00'); // 20_000_000
    expect(bytesToHex(bytes.slice(54, 56))).toBe('0x000a');             // 10
  });

  it('puts the payee count at 56 and length-prefixed payees after it', () => {
    expect(bytes[56]).toBe(3);
    expect(bytesToHex(bytes.slice(57, 77))).toBe(A(0x11));
    expect(bytes[77]).toBe('Cafe Sat'.length);
    expect(new TextDecoder().decode(bytes.slice(78, 78 + 8))).toBe('Cafe Sat');
  });

  it('has the documented minimum and maximum sizes', () => {
    expect(encodePolicy({ ...demo(), payees: [] })).toHaveLength(POLICY_WIRE_MIN_LEN);
    expect(POLICY_WIRE_MIN_LEN).toBe(57);
    const max = encodePolicy({ ...demo(), payees: Array.from({ length: MAX_PAYEES }, (_, i) => ({ address: A(i + 1), label: 'x'.repeat(MAX_LABEL_BYTES) })) });
    expect(max).toHaveLength(57 + MAX_PAYEES * (20 + 1 + MAX_LABEL_BYTES));
    expect(max.length).toBe(353);
    expect(max.length).toBeLessThan(1024); // must fit the device reassembly buffer
  });
});

describe('encodePolicy rejects bad input', () => {
  it('rejects more than 8 payees', () => {
    const payees = Array.from({ length: MAX_PAYEES + 1 }, (_, i) => ({ address: A(i + 1), label: 'x' }));
    expect(() => encodePolicy({ ...demo(), payees })).toThrow(/at most 8 payees/i);
  });

  it('rejects a label over 16 bytes', () => {
    expect(() => encodePolicy({ ...demo(), payees: [{ address: A(1), label: 'x'.repeat(17) }] })).toThrow(/16 bytes/i);
  });

  it('rejects a short label whose UTF-8 encoding is over 16 bytes', () => {
    expect(() => encodePolicy({ ...demo(), payees: [{ address: A(1), label: '€'.repeat(6) }] })).toThrow(/16 bytes/i); // 18 bytes, 6 chars
  });

  it('rejects a malformed address', () => {
    expect(() => encodePolicy({ ...demo(), payees: [{ address: '0x1234' as any, label: 'short' }] })).toThrow(/20 bytes/i);
    expect(() => encodePolicy({ ...demo(), token: '0xnothex' as any })).toThrow();
  });

  it('rejects duplicate payee addresses, case-insensitively', () => {
    const payees = [{ address: A(0x11), label: 'one' }, { address: A(0x11).toUpperCase() as any, label: 'two' }];
    expect(() => encodePolicy({ ...demo(), payees })).toThrow(/duplicate/i);
  });

  it('rejects out-of-range numbers', () => {
    expect(() => encodePolicy({ ...demo(), budget: 2n ** 64n })).toThrow(/u64/i);
    expect(() => encodePolicy({ ...demo(), autoMax: -1n })).toThrow(/u64/i);
    expect(() => encodePolicy({ ...demo(), maxCount: 0x10000 })).toThrow(/u16/i);
    expect(() => encodePolicy({ ...demo(), maxCount: -1 })).toThrow(/u16/i);
    expect(() => encodePolicy({ ...demo(), maxCount: 1.5 })).toThrow(/integer/i);
  });

  it('rejects autoMax above hardMax, which could never trigger an orange screen', () => {
    expect(() => encodePolicy({ ...demo(), autoMax: 60_000_000n, hardMax: 50_000_000n })).toThrow(/autoMax/i);
  });
});

describe('decodePolicy rejects bad input', () => {
  const ok = encodePolicy(demo());

  it('rejects a buffer shorter than the header', () => {
    expect(() => decodePolicy(ok.slice(0, POLICY_WIRE_MIN_LEN - 1))).toThrow(/too short/i);
    expect(() => decodePolicy(new Uint8Array(0))).toThrow(/too short/i);
  });

  it('rejects an unknown version', () => {
    const bad = Uint8Array.from(ok); bad[0] = 99;
    expect(() => decodePolicy(bad)).toThrow(/version/i);
  });

  it('rejects unknown flag bits instead of ignoring them', () => {
    const bad = Uint8Array.from(ok); bad[1] = 0x02;
    expect(() => decodePolicy(bad)).toThrow(/flag/i);
  });

  it('rejects a payee count over 8', () => {
    const bad = Uint8Array.from(ok); bad[56] = 9;
    expect(() => decodePolicy(bad)).toThrow(/at most 8/i);
  });

  it('rejects a label length over 16', () => {
    const bad = Uint8Array.from(ok); bad[77] = 17;
    expect(() => decodePolicy(bad)).toThrow(/16/);
  });

  it('rejects a truncated payee list', () => {
    expect(() => decodePolicy(ok.slice(0, ok.length - 1))).toThrow(/truncated|too short/i);
  });

  it('rejects trailing bytes, so a smuggled payee cannot hide after the policy', () => {
    const bad = new Uint8Array(ok.length + 1); bad.set(ok);
    expect(() => decodePolicy(bad)).toThrow(/trailing/i);
  });

  it('rejects a label that is not valid UTF-8', () => {
    const p: Policy = { ...demo(), payees: [{ address: A(1), label: 'ok' }] };
    const bad = Uint8Array.from(encodePolicy(p));
    bad[78] = 0xff; bad[79] = 0xfe; // inside the 2-byte label
    expect(() => decodePolicy(bad)).toThrow(/utf-8/i);
  });
});

describe('device state codec', () => {
  const state = (): DeviceState => ({
    sessionArmed: true,
    hasCredentials: false,
    spent: 3_000_000n,
    count: 1,
    lastPayment: { label: 'Cafe Sat', value: 3_000_000n },
    policy: demo(),
  });

  it('round-trips a full state', () => {
    expect(decodeState(encodeState(state()))).toEqual(state());
  });

  it('round-trips with no last payment', () => {
    const s = { ...state(), lastPayment: null };
    expect(decodeState(encodeState(s))).toEqual(s);
  });

  it('round-trips a disarmed session with credentials stored', () => {
    const s = { ...state(), sessionArmed: false, hasCredentials: true };
    expect(decodeState(encodeState(s))).toEqual(s);
  });

  it('carries the policy unchanged, so the dashboard mirrors exactly what the device enforces', () => {
    const decoded = decodeState(encodeState(state()));
    expect(encodePolicy(decoded.policy)).toEqual(encodePolicy(demo()));
  });

  it('rejects trailing bytes and unknown versions', () => {
    const ok = encodeState(state());
    const bad = new Uint8Array(ok.length + 1); bad.set(ok);
    expect(() => decodeState(bad)).toThrow(/trailing/i);
    const v = Uint8Array.from(ok); v[0] = 7;
    expect(() => decodeState(v)).toThrow(/version/i);
  });

  it('a fresh device (no policy) still produces a decodable state', () => {
    const empty: DeviceState = {
      sessionArmed: false, hasCredentials: false, spent: 0n, count: 0, lastPayment: null,
      policy: { active: false, chainId: 0n, token: `0x${'00'.repeat(20)}`, autoMax: 0n, hardMax: 0n, budget: 0n, maxCount: 0, payees: [] },
    };
    expect(decodeState(encodeState(empty))).toEqual(empty);
  });
});
