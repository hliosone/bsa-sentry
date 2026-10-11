// APDU chunking contract tests.
// The Reassembler mirrors the device byte for byte, including its two error paths
// (0xB004 payload too large, 0xB00B "next" without a "first"), so that a host bug is
// caught here instead of on hardware where the protocol desyncs.
import { describe, expect, it } from 'vitest';
import {
  CLA, INS, MAX_APDU_DATA, MAX_REASSEMBLY, P1_FIRST, P1_NEXT, P2_MORE, P2_LAST,
  SW, encodeChunks, decodeChunks, Reassembler, ApduError,
} from '../src/index.js';

const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

describe('encodeChunks', () => {
  it('uses 250-byte chunks', () => {
    expect(MAX_APDU_DATA).toBe(250);
    expect(MAX_REASSEMBLY).toBe(1024);
  });

  it('encodes an empty payload as one APDU with Lc 0', () => {
    const [apdu, ...rest] = encodeChunks(INS.SET_POLICY, payload(0));
    expect(rest).toHaveLength(0);
    expect(Array.from(apdu!)).toEqual([CLA, INS.SET_POLICY, P1_FIRST, P2_LAST, 0]);
  });

  it('encodes a payload at the chunk boundary as one APDU', () => {
    const apdus = encodeChunks(INS.SET_POLICY, payload(250));
    expect(apdus).toHaveLength(1);
    expect(apdus[0]![2]).toBe(P1_FIRST);
    expect(apdus[0]![3]).toBe(P2_LAST);
    expect(apdus[0]![4]).toBe(250);
    expect(apdus[0]).toHaveLength(5 + 250);
  });

  it('splits one byte past the boundary into two APDUs', () => {
    const apdus = encodeChunks(INS.SET_POLICY, payload(251));
    expect(apdus).toHaveLength(2);
    expect([apdus[0]![2], apdus[0]![3], apdus[0]![4]]).toEqual([P1_FIRST, P2_MORE, 250]);
    expect([apdus[1]![2], apdus[1]![3], apdus[1]![4]]).toEqual([P1_NEXT, P2_LAST, 1]);
  });

  it('marks only the first chunk P1_FIRST and only the last chunk P2_LAST', () => {
    const apdus = encodeChunks(INS.RESTORE, payload(1024));
    expect(apdus).toHaveLength(Math.ceil(1024 / 250)); // 5
    expect(apdus.map((a) => a[2])).toEqual([P1_FIRST, P1_NEXT, P1_NEXT, P1_NEXT, P1_NEXT]);
    expect(apdus.map((a) => a[3])).toEqual([P2_MORE, P2_MORE, P2_MORE, P2_MORE, P2_LAST]);
    expect(apdus.map((a) => a[4])).toEqual([250, 250, 250, 250, 24]);
  });

  it('refuses to encode a payload the device could not reassemble', () => {
    expect(() => encodeChunks(INS.SET_POLICY, payload(MAX_REASSEMBLY + 1))).toThrow(/1024/);
  });

  it('carries the CLA and INS on every chunk', () => {
    for (const a of encodeChunks(INS.STORE_CREDENTIALS, payload(600))) {
      expect(a[0]).toBe(CLA);
      expect(a[1]).toBe(INS.STORE_CREDENTIALS);
    }
  });
});

describe('encode/decode round trip', () => {
  for (const n of [0, 1, 249, 250, 251, 499, 500, 501, 1023, 1024]) {
    it(`round-trips ${n} bytes`, () => {
      const p = payload(n);
      const { ins, payload: back } = decodeChunks(encodeChunks(INS.SET_POLICY, p));
      expect(ins).toBe(INS.SET_POLICY);
      expect(back).toEqual(p);
    });
  }
});

describe('Reassembler mirrors the device', () => {
  const feed = (r: Reassembler, apdus: Uint8Array[]) => {
    let out: Uint8Array | null = null;
    for (const a of apdus) out = r.push(a[2]!, a[3]!, a.subarray(5));
    return out;
  };

  it('returns null until the last chunk, then the whole payload', () => {
    const r = new Reassembler();
    const apdus = encodeChunks(INS.SET_POLICY, payload(501));
    expect(r.push(apdus[0]![2]!, apdus[0]![3]!, apdus[0]!.subarray(5))).toBeNull();
    expect(r.push(apdus[1]![2]!, apdus[1]![3]!, apdus[1]!.subarray(5))).toBeNull();
    const done = r.push(apdus[2]![2]!, apdus[2]![3]!, apdus[2]!.subarray(5));
    expect(done).toEqual(payload(501));
  });

  it('accepts exactly 1024 bytes', () => {
    expect(feed(new Reassembler(), encodeChunks(INS.RESTORE, payload(1024)))).toEqual(payload(1024));
  });

  /** 1000 bytes in, then a 25-byte chunk tips it one byte over the 1024 limit. */
  const overflowed = () => {
    const r = new Reassembler();
    for (let i = 0; i < 4; i++) r.push(i === 0 ? P1_FIRST : P1_NEXT, P2_MORE, payload(250));
    return r;
  };

  it('answers 0xB004 when the payload would exceed 1024 bytes', () => {
    expect(SW.PAYLOAD_TOO_LARGE).toBe(0xb004);
    try {
      overflowed().push(P1_NEXT, P2_LAST, payload(25));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApduError);
      expect((e as ApduError).sw).toBe(SW.PAYLOAD_TOO_LARGE);
    }
  });

  it('drops the partial buffer after an overflow, so the host cannot keep pushing', () => {
    const r = overflowed();
    expect(() => r.push(P1_NEXT, P2_LAST, payload(25))).toThrow(ApduError);
    // The transfer is gone: a following "next" is now a next-without-first, not a resumption.
    try {
      r.push(P1_NEXT, P2_LAST, payload(1));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ApduError).sw).toBe(SW.NEXT_WITHOUT_FIRST);
    }
    // And a fresh transfer starts clean.
    expect(r.push(P1_FIRST, P2_LAST, Uint8Array.of(7))).toEqual(Uint8Array.of(7));
  });

  it('answers 0xB00B on a "next" chunk without a "first"', () => {
    const r = new Reassembler();
    try {
      r.push(P1_NEXT, P2_LAST, payload(10));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApduError);
      expect((e as ApduError).sw).toBe(SW.NEXT_WITHOUT_FIRST);
    }
    expect(SW.NEXT_WITHOUT_FIRST).toBe(0xb00b);
  });

  it('answers 0xB00B after a completed transfer if the host sends "next" again', () => {
    const r = new Reassembler();
    r.push(P1_FIRST, P2_LAST, payload(5));
    expect(() => r.push(P1_NEXT, P2_LAST, payload(5))).toThrow(ApduError);
  });

  it('a new "first" chunk discards an abandoned transfer instead of concatenating', () => {
    const r = new Reassembler();
    r.push(P1_FIRST, P2_MORE, payload(250));
    r.push(P1_FIRST, P2_LAST, Uint8Array.of(9, 9, 9));
    // If the abandoned 250 bytes had leaked in, the result would not be 3 bytes.
    const r2 = new Reassembler();
    r2.push(P1_FIRST, P2_MORE, payload(250));
    expect(r2.push(P1_FIRST, P2_LAST, Uint8Array.of(9, 9, 9))).toEqual(Uint8Array.of(9, 9, 9));
  });

  it('rejects unknown P1 and P2 values rather than guessing', () => {
    expect(() => new Reassembler().push(0x02, P2_LAST, payload(1))).toThrow(/P1/);
    expect(() => new Reassembler().push(P1_FIRST, 0x7f, payload(1))).toThrow(/P2/);
  });

  it('rejects a chunk over 250 bytes, which cannot come from a valid APDU', () => {
    expect(() => new Reassembler().push(P1_FIRST, P2_MORE, payload(251))).toThrow(/250/);
  });
});

describe('decodeChunks validates what it is given', () => {
  it('rejects an empty list', () => {
    expect(() => decodeChunks([])).toThrow(/no apdu/i);
  });

  it('rejects a mixed INS', () => {
    const a = encodeChunks(INS.SET_POLICY, payload(300));
    a[1]![1] = INS.PAY;
    expect(() => decodeChunks(a)).toThrow(/same INS/i);
  });

  it('rejects a declared length that does not match the data', () => {
    const a = encodeChunks(INS.SET_POLICY, payload(10));
    a[0]![4] = 99;
    expect(() => decodeChunks(a)).toThrow(/Lc/);
  });

  it('rejects a sequence whose last chunk is not marked last', () => {
    const a = encodeChunks(INS.SET_POLICY, payload(300));
    a[1]![3] = P2_MORE;
    expect(() => decodeChunks(a)).toThrow(/last/i);
  });
});

describe('instruction set', () => {
  it('matches the spec, and has no silent-signing command', () => {
    expect(INS).toEqual({
      GET_ADDRESS: 0x08, SET_POLICY: 0x0a, PAY: 0x0b, GET_STATE: 0x0c, CLEAR_POLICY: 0x0d,
      SIGN_BIND: 0x0e, SIGN_LOGIN: 0x0f, SIGN_DELEGATION: 0x10, STORE_CREDENTIALS: 0x11,
      GET_CREDENTIALS: 0x12, RESTORE: 0x13,
    });
    // The feasibility app had PING 0x07, SIGN_3009 0x09 (tap) and SIGN_3009_SILENT 0x0F
    // (no policy, no tap). None of them exist here; 0x0F is SIGN_LOGIN, which always taps.
    expect(Object.values(INS)).not.toContain(0x07);
    expect(Object.values(INS)).not.toContain(0x09);
    expect(INS.SIGN_LOGIN).toBe(0x0f);
  });

  it('uses CLA 0xE0', () => expect(CLA).toBe(0xe0));
});
