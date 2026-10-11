// APDU payload encoders for the three things 0xMAIN signs: Login, Bind and AgentDelegation.
// The device rebuilds the EIP-712 digest from exactly these raw fields, so the layout is a
// frozen contract and every bound is checked here.
import { describe, expect, it } from 'vitest';
import { bytesToHex } from 'viem';
import {
  MAX_AGENT_NAME_BYTES, MAX_CLAIMS, MAX_CLAIM_BYTES, MAX_ORIGIN_BYTES, MAX_VERIFIER_BYTES,
  encodeLoginPayload, encodeBindPayload, encodeDelegationPayload,
} from '../src/index.js';

const b32 = (h: string) => `0x${h.repeat(32)}` as const;
const AGENT = '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' as const;

describe('Login payload', () => {
  const base = { chainId: 5042002n, origin: 'https://bsa-sentry.ch', nonce: b32('01'), issuedAt: 1_760_000_000n, expiresAt: 1_760_000_300n };

  it('is chainId | originLen | origin | nonce | issuedAt | expiresAt', () => {
    const out = encodeLoginPayload(base);
    // The chain id leads, because it is part of the EIP-712 domain.
    expect(bytesToHex(out.subarray(0, 8))).toBe('0x00000000004cef52');
    expect(out[8]).toBe(base.origin.length);
    expect(new TextDecoder().decode(out.subarray(9, 9 + base.origin.length))).toBe(base.origin);
    const at = 9 + base.origin.length;
    expect(bytesToHex(out.subarray(at, at + 32))).toBe(base.nonce);
    expect(bytesToHex(out.subarray(at + 32, at + 40))).toBe('0x0000000068e77800');
    expect(bytesToHex(out.subarray(at + 40, at + 48))).toBe('0x0000000068e7792c');
    expect(out).toHaveLength(8 + 1 + base.origin.length + 32 + 8 + 8);
  });

  it('rejects a chainId that does not fit a u64', () => {
    expect(() => encodeLoginPayload({ ...base, chainId: 2n ** 64n })).toThrow(/u64/i);
  });

  it('accepts an origin at the limit and rejects one past it', () => {
    expect(() => encodeLoginPayload({ ...base, origin: 'a'.repeat(MAX_ORIGIN_BYTES) })).not.toThrow();
    expect(() => encodeLoginPayload({ ...base, origin: 'a'.repeat(MAX_ORIGIN_BYTES + 1) })).toThrow(/origin/i);
  });

  it('measures the origin in UTF-8 bytes, not codepoints', () => {
    const almost = '€'.repeat(Math.floor(MAX_ORIGIN_BYTES / 3) + 1); // 3 bytes each
    expect(() => encodeLoginPayload({ ...base, origin: almost })).toThrow(/origin/i);
  });

  it('rejects an empty origin: the user must see where they are logging in', () => {
    expect(() => encodeLoginPayload({ ...base, origin: '' })).toThrow(/origin/i);
  });

  it('rejects a malformed nonce or out-of-range timestamps', () => {
    expect(() => encodeLoginPayload({ ...base, nonce: '0xabcd' as any })).toThrow(/32 bytes/i);
    expect(() => encodeLoginPayload({ ...base, expiresAt: 2n ** 64n })).toThrow(/u64/i);
  });

  it('fits a single APDU', () => {
    expect(encodeLoginPayload({ ...base, origin: 'a'.repeat(MAX_ORIGIN_BYTES) }).length).toBeLessThanOrEqual(250);
  });
});

describe('Bind payload', () => {
  const base = { chainId: 5042002n, verifier: 'https://verifier-backend.eudiw.dev', session: b32('02'), expiresAt: 1_760_000_900n };

  it('is chainId | verifierLen | verifier | session | expiresAt', () => {
    const out = encodeBindPayload(base);
    expect(bytesToHex(out.subarray(0, 8))).toBe('0x00000000004cef52');
    expect(out[8]).toBe(base.verifier.length);
    expect(new TextDecoder().decode(out.subarray(9, 9 + base.verifier.length))).toBe(base.verifier);
    const at = 9 + base.verifier.length;
    expect(bytesToHex(out.subarray(at, at + 32))).toBe(base.session);
    expect(out).toHaveLength(8 + 1 + base.verifier.length + 32 + 8);
  });

  it('bounds the verifier string', () => {
    expect(() => encodeBindPayload({ ...base, verifier: 'a'.repeat(MAX_VERIFIER_BYTES + 1) })).toThrow(/verifier/i);
    expect(() => encodeBindPayload({ ...base, verifier: '' })).toThrow(/verifier/i);
  });
});

describe('AgentDelegation payload', () => {
  const base = {
    chainId: 5042002n, agent: AGENT, agentName: 'Claude', attestation: b32('03'),
    claims: ['age_over_18'], expiresAt: 1_762_592_000n, nonce: b32('04'),
  };

  it('is chainId | agent | nameLen | name | attestation | claimCount | claims | expiresAt | nonce', () => {
    const out = encodeDelegationPayload(base);
    expect(bytesToHex(out.subarray(0, 8))).toBe('0x00000000004cef52');
    expect(bytesToHex(out.subarray(8, 28))).toBe(AGENT);
    expect(out[28]).toBe('Claude'.length);
    let at = 29 + 'Claude'.length;
    expect(bytesToHex(out.subarray(at, at + 32))).toBe(base.attestation);
    at += 32;
    expect(out[at]).toBe(1);
    at += 1;
    expect(out[at]).toBe('age_over_18'.length);
    at += 1 + 'age_over_18'.length;
    expect(bytesToHex(out.subarray(at, at + 8))).toBe('0x00000000690f0500');
    at += 8;
    expect(bytesToHex(out.subarray(at, at + 32))).toBe(base.nonce);
    expect(out).toHaveLength(at + 32);
  });

  it('round-trips through the credentials delegation layout limits', () => {
    expect(() => encodeDelegationPayload({ ...base, agentName: 'n'.repeat(MAX_AGENT_NAME_BYTES) })).not.toThrow();
    expect(() => encodeDelegationPayload({ ...base, agentName: 'n'.repeat(MAX_AGENT_NAME_BYTES + 1) })).toThrow(/24 bytes/i);
    expect(() => encodeDelegationPayload({ ...base, claims: Array.from({ length: MAX_CLAIMS }, () => 'c') })).not.toThrow();
    expect(() => encodeDelegationPayload({ ...base, claims: Array.from({ length: MAX_CLAIMS + 1 }, () => 'c') })).toThrow(/at most 4/i);
    expect(() => encodeDelegationPayload({ ...base, claims: ['c'.repeat(MAX_CLAIM_BYTES + 1)] })).toThrow(/32 bytes/i);
  });

  it('rejects an empty agent name or claim: both are shown on screen', () => {
    expect(() => encodeDelegationPayload({ ...base, agentName: '' })).toThrow(/empty/i);
    expect(() => encodeDelegationPayload({ ...base, claims: [''] })).toThrow(/empty/i);
  });

  it('accepts no claims at all', () => {
    expect(() => encodeDelegationPayload({ ...base, claims: [] })).not.toThrow();
  });

  it('rejects a malformed agent address', () => {
    expect(() => encodeDelegationPayload({ ...base, agent: '0x1234' as any })).toThrow(/20 bytes/i);
  });
});
