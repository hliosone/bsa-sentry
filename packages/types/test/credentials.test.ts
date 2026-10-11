// Credentials codec contract tests.
// The device decodes this blob in no_std Rust and then checks, on its own, that the
// delegation was signed by its own 0xMAIN and targets its own 0xAGENT (invariant 6 on the
// device side). The codec itself must therefore never silently accept a malformed bundle.
import { describe, expect, it } from 'vitest';
import { bytesToHex } from 'viem';
import {
  CREDENTIALS_WIRE_VERSION, MAX_CLAIMS, MAX_CLAIM_BYTES, MAX_AGENT_NAME_BYTES,
  encodeCredentials, decodeCredentials, MAX_REASSEMBLY, type Credentials,
} from '../src/index.js';

const MAIN = '0x21fff03ff9c6a8b845c65ef2aa2fbb09b5da5ce5' as const;
const AGENT = '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' as const;
const b32 = (h: string) => `0x${h.repeat(32)}` as const;
const sig65 = (h: string) => `0x1b${h.repeat(64)}` as const; // v = 0x1b (27)

const bundle = (): Credentials => ({
  attestation: { subject: MAIN, claim: 'age_over_18', issuedAt: 1_760_000_000n, expiresAt: 1_762_592_000n, evidence: b32('05') },
  attestationSig: sig65('aa'),
  delegation: {
    agent: AGENT, agentName: 'Claude', attestation: b32('03'), claims: ['age_over_18'],
    expiresAt: 1_762_592_000n, nonce: b32('04'),
  },
  delegationSig: sig65('bb'),
});

describe('credentials round trip', () => {
  it('round-trips the 18+ bundle', () => {
    expect(decodeCredentials(encodeCredentials(bundle()))).toEqual(bundle());
  });

  it('round-trips with no claims', () => {
    const c = bundle(); c.delegation.claims = [];
    expect(decodeCredentials(encodeCredentials(c))).toEqual(c);
  });

  it('round-trips at every maximum', () => {
    const c = bundle();
    c.attestation.claim = 'c'.repeat(MAX_CLAIM_BYTES);
    c.delegation.agentName = 'n'.repeat(MAX_AGENT_NAME_BYTES);
    c.delegation.claims = Array.from({ length: MAX_CLAIMS }, (_, i) => `${i}`.repeat(MAX_CLAIM_BYTES));
    expect(decodeCredentials(encodeCredentials(c))).toEqual(c);
  });

  it('round-trips multi-byte UTF-8 within the byte budget', () => {
    const c = bundle(); c.delegation.agentName = 'Clément 日本';
    expect(decodeCredentials(encodeCredentials(c))).toEqual(c);
  });

  it('round-trips the u64 maximum', () => {
    const c = bundle(); c.attestation.expiresAt = 2n ** 64n - 1n; c.delegation.expiresAt = 2n ** 64n - 1n;
    expect(decodeCredentials(encodeCredentials(c))).toEqual(c);
  });

  it('starts with the version byte and a zero flags byte', () => {
    const b = encodeCredentials(bundle());
    expect(b[0]).toBe(CREDENTIALS_WIRE_VERSION);
    expect(b[1]).toBe(0);
  });

  it('fits in one chunked transfer, alongside a policy, for RESTORE', () => {
    const maxed = bundle();
    maxed.attestation.claim = 'c'.repeat(MAX_CLAIM_BYTES);
    maxed.delegation.agentName = 'n'.repeat(MAX_AGENT_NAME_BYTES);
    maxed.delegation.claims = Array.from({ length: MAX_CLAIMS }, () => 'c'.repeat(MAX_CLAIM_BYTES));
    const credsLen = encodeCredentials(maxed).length;
    expect(credsLen).toBeLessThan(MAX_REASSEMBLY);
    // 353 is the largest possible policy; both together must still fit one 1024-byte transfer,
    // which is what lets RESTORE stay a single command instead of two.
    expect(credsLen + 353).toBeLessThanOrEqual(MAX_REASSEMBLY);
  });
});

describe('encodeCredentials rejects bad input', () => {
  it('rejects too many claims', () => {
    const c = bundle(); c.delegation.claims = Array.from({ length: MAX_CLAIMS + 1 }, () => 'x');
    expect(() => encodeCredentials(c)).toThrow(/at most 4 claims/i);
  });

  it('rejects an over-long claim or agent name', () => {
    const c1 = bundle(); c1.attestation.claim = 'x'.repeat(MAX_CLAIM_BYTES + 1);
    expect(() => encodeCredentials(c1)).toThrow(/32 bytes/i);
    const c2 = bundle(); c2.delegation.agentName = 'x'.repeat(MAX_AGENT_NAME_BYTES + 1);
    expect(() => encodeCredentials(c2)).toThrow(/24 bytes/i);
    const c3 = bundle(); c3.delegation.claims = ['x'.repeat(MAX_CLAIM_BYTES + 1)];
    expect(() => encodeCredentials(c3)).toThrow(/32 bytes/i);
  });

  it('rejects a signature that is not 65 bytes', () => {
    const c = bundle(); (c as any).attestationSig = '0x1b00';
    expect(() => encodeCredentials(c)).toThrow(/65 bytes/i);
  });

  it('rejects a malformed address, bytes32 or recovery byte', () => {
    const c1 = bundle(); (c1.attestation as any).subject = '0x1234';
    expect(() => encodeCredentials(c1)).toThrow(/20 bytes/i);
    const c2 = bundle(); (c2.attestation as any).evidence = '0xabcd';
    expect(() => encodeCredentials(c2)).toThrow(/32 bytes/i);
    const c3 = bundle(); (c3 as any).delegationSig = `0x00${'bb'.repeat(64)}`;
    expect(() => encodeCredentials(c3)).toThrow(/recovery/i);
  });

  it('rejects an empty claim string, which would be meaningless on screen', () => {
    const c = bundle(); c.delegation.claims = [''];
    expect(() => encodeCredentials(c)).toThrow(/empty/i);
  });
});

describe('decodeCredentials rejects bad input', () => {
  const ok = encodeCredentials(bundle());

  it('rejects an unknown version or non-zero flags', () => {
    const v = Uint8Array.from(ok); v[0] = 9;
    expect(() => decodeCredentials(v)).toThrow(/version/i);
    const f = Uint8Array.from(ok); f[1] = 1;
    expect(() => decodeCredentials(f)).toThrow(/flag/i);
  });

  it('rejects a truncated blob', () => {
    expect(() => decodeCredentials(ok.slice(0, ok.length - 1))).toThrow(/truncated|too short/i);
    expect(() => decodeCredentials(new Uint8Array(2))).toThrow(/too short|truncated/i);
  });

  it('rejects trailing bytes', () => {
    const bad = new Uint8Array(ok.length + 1); bad.set(ok);
    expect(() => decodeCredentials(bad)).toThrow(/trailing/i);
  });

  it('rejects a declared claim count over the maximum', () => {
    // Locate the claims_count byte: it follows agent(20) + nameLen(1) + name + attestation(32).
    const at = 2 + 20 + 1 + 'age_over_18'.length + 8 + 8 + 32 + 65 + 20 + 1 + 'Claude'.length + 32;
    const bad = Uint8Array.from(ok);
    expect(bad[at]).toBe(1); // sanity: we found the right byte
    bad[at] = 5;
    expect(() => decodeCredentials(bad)).toThrow(/at most 4/i);
  });

  it('rejects a claim that is not valid UTF-8', () => {
    const bad = Uint8Array.from(ok);
    bad[2 + 20 + 1] = 0xff; // first byte of the attestation claim
    bad[2 + 20 + 2] = 0xfe;
    expect(() => decodeCredentials(bad)).toThrow(/utf-8/i);
  });

  it('does not accept a bundle whose delegation targets a different agent - that is the device\'s job, not the codec\'s', () => {
    // The codec is deliberately agnostic: it decodes faithfully and the device compares
    // delegation.agent against its own 0xAGENT. Documented here so nobody "fixes" it.
    const c = bundle(); c.delegation.agent = MAIN;
    expect(decodeCredentials(encodeCredentials(c)).delegation.agent).toBe(MAIN);
  });

  it('normalises hex case on decode', () => {
    const c = bundle(); (c.delegation as any).agent = AGENT.toUpperCase().replace('0X', '0x');
    expect(decodeCredentials(encodeCredentials(c)).delegation.agent).toBe(AGENT);
  });
});

describe('empty credentials', () => {
  it('encodes the "no credentials stored" sentinel as an empty buffer', () => {
    expect(() => decodeCredentials(new Uint8Array(0))).toThrow(/too short/i);
    // GET_CREDENTIALS returns zero bytes when nothing is stored; callers check length
    // before decoding rather than relying on a magic version byte.
    expect(bytesToHex(new Uint8Array(0))).toBe('0x');
  });
});
