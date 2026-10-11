// The committed fixtures are the frozen contract. If the codec changes without regenerating
// them (pnpm fixtures:wire) this fails, which is the point: Rust reads the same file.
import { describe, expect, it } from 'vitest';
import {
  encodePolicy, decodePolicy, encodeState, decodeState, encodeCredentials, decodeCredentials,
  encodeChunks, INS, MAX_REASSEMBLY,
} from '../src/index.js';
import wire from '../fixtures/wire.json' with { type: 'json' };

const hex = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const bytes = (h: string) => Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));
/** JSON holds u64 as decimal strings; revive them before comparing to a decoded struct. */
const revive = (v: any): any => JSON.parse(JSON.stringify(v), (_k, x) => x);
const normalise = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

describe('policy fixtures', () => {
  for (const f of wire.policies) {
    describe(f.name, () => {
      it('decodes to the recorded structure', () => {
        expect(normalise(decodePolicy(bytes(f.hex)))).toEqual(revive(f.decoded));
      });
      it('re-encodes to the exact same bytes', () => {
        expect(hex(encodePolicy(decodePolicy(bytes(f.hex))))).toBe(f.hex);
      });
      it('fits the device reassembly buffer', () => {
        expect((f.hex.length - 2) / 2).toBeLessThanOrEqual(MAX_REASSEMBLY);
      });
    });
  }

  it('covers the empty, demo, full and extreme cases', () => {
    expect(wire.policies.map((p) => p.name)).toEqual(['demo', 'empty', 'full-8-payees', 'field-maxima']);
  });
});

describe('state fixtures', () => {
  for (const f of wire.states) {
    it(`${f.name} round-trips byte-for-byte`, () => {
      expect(normalise(decodeState(bytes(f.hex)))).toEqual(revive(f.decoded));
      expect(hex(encodeState(decodeState(bytes(f.hex))))).toBe(f.hex);
    });
  }
});

describe('credentials fixtures', () => {
  for (const f of wire.credentials) {
    it(`${f.name} round-trips byte-for-byte`, () => {
      expect(normalise(decodeCredentials(bytes(f.hex)))).toEqual(revive(f.decoded));
      expect(hex(encodeCredentials(decodeCredentials(bytes(f.hex))))).toBe(f.hex);
    });
  }

  it('the largest credentials plus the largest policy still fit one chunked transfer', () => {
    const maxCreds = Math.max(...wire.credentials.map((c) => (c.hex.length - 2) / 2));
    const maxPolicy = Math.max(...wire.policies.map((p) => (p.hex.length - 2) / 2));
    expect(maxCreds + maxPolicy).toBeLessThanOrEqual(MAX_REASSEMBLY);
  });
});

describe('invalid fixtures are rejected', () => {
  for (const f of wire.invalid.policies) {
    it(`policy: ${f.why}`, () => {
      expect(() => decodePolicy(bytes(f.hex)), f.why).toThrow();
    });
  }
  for (const f of wire.invalid.credentials) {
    it(`credentials: ${f.why}`, () => {
      expect(() => decodeCredentials(bytes(f.hex)), f.why).toThrow();
    });
  }
});

describe('chunking fixtures', () => {
  for (const f of wire.chunking) {
    it(`${f.payloadLen} bytes -> ${f.apdus.length} APDU(s)`, () => {
      const payload = Uint8Array.from({ length: f.payloadLen }, (_, i) => i & 0xff);
      expect(encodeChunks(INS.SET_POLICY, payload).map(hex)).toEqual(f.apdus);
    });
  }

  it('records the boundaries the spec asks for', () => {
    expect(wire.chunking.map((c) => c.payloadLen)).toEqual([0, 1, 250, 251, 500, 501, 1024]);
  });
});

describe('limits are recorded for the Rust side', () => {
  it('match the exported constants', () => {
    expect(wire.limits).toEqual({
      MAX_PAYEES: 8, MAX_LABEL_BYTES: 16, MAX_CLAIMS: 4, MAX_CLAIM_BYTES: 32, MAX_AGENT_NAME_BYTES: 24,
    });
  });
});
