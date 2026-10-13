// Agent identity, one right at a time: the delegations the page asks the Flex to sign when a
// right is removed or added. They must reuse the stored attestation and only change the claims
// and the nonce, or the facilitator (and the device's STORE_CREDENTIALS check) would refuse them.
import { describe, expect, it } from 'vitest';
import { attestedClaims, type Credentials } from '@bsa-sentry/types';
import { flexReview, grantableRights, randomNonce, regrant, stillValid, withoutRight, withRight } from '../src/pages/Badge.js';

const NONCE = `0x${'ab'.repeat(32)}` as const;
const held = (claims: string[], attested = 'age_over_18,jurisdiction:CH'): Credentials => ({
  chainId: 5042002n,
  attestation: { subject: `0x${'11'.repeat(20)}`, claim: attested, issuedAt: 1_760_000_000n, expiresAt: 1_762_592_000n, evidence: `0x${'22'.repeat(32)}` },
  attestationSig: `0x${'1b'.repeat(65)}`,
  delegation: {
    agent: '0xAbCdEf0123456789abcdef0123456789ABCDEF01', agentName: 'Claude', attestation: `0x${'33'.repeat(32)}`,
    claims, expiresAt: 1_762_000_000n, nonce: `0x${'44'.repeat(32)}`,
  },
  delegationSig: `0x${'1c'.repeat(65)}`,
});

describe('removing one right', () => {
  it('keeps everything but the claims and the nonce', () => {
    const h = held(['age_over_18', 'jurisdiction:CH']);
    const d = withoutRight(h, 'jurisdiction:CH', NONCE);
    expect(d).toEqual({ ...h.delegation, claims: ['age_over_18'], nonce: NONCE });
  });

  it('refuses to remove the last right: that is a full revocation', () => {
    expect(() => withoutRight(held(['age_over_18']), 'age_over_18', NONCE)).toThrow(/revoke all/);
  });
});

describe('adding one right', () => {
  it('adds a right the attestation proves, claims sorted as at the first grant', () => {
    const h = held(['jurisdiction:CH']);
    const d = withRight(h, 'age_over_18', NONCE);
    expect(d).toEqual({ ...h.delegation, claims: ['age_over_18', 'jurisdiction:CH'], nonce: NONCE });
    expect(d.claims.every((c) => attestedClaims(h.attestation.claim).includes(c))).toBe(true);
  });

  it('refuses a right the stored attestation does not prove: that needs a new scan', () => {
    expect(() => withRight(held(['age_over_18']), 'jurisdiction:FR', NONCE)).toThrow(/scan again/);
  });

  it('never repeats a right', () => {
    expect(regrant(held(['age_over_18']), ['age_over_18', 'age_over_18'], NONCE).claims).toEqual(['age_over_18']);
  });
});

describe('what the page offers', () => {
  it('lists the proven rights the agent does not hold yet', () => {
    expect(grantableRights(held(['age_over_18']))).toEqual(['jurisdiction:CH']);
    expect(grantableRights(held(['age_over_18', 'jurisdiction:CH']))).toEqual([]);
    expect(grantableRights(held(['age_over_18'], 'age_over_18'))).toEqual([]);
  });

  it('allows changes only while both the delegation and the attestation are unexpired', () => {
    const h = held(['age_over_18']);
    expect(stillValid(h, 1_761_999_999)).toBe(true);
    expect(stillValid(h, 1_762_000_000)).toBe(false);
    const attestationFirst = { ...h, attestation: { ...h.attestation, expiresAt: 1_761_000_000n } };
    expect(stillValid(attestationFirst, 1_761_000_000)).toBe(false);
  });

  it('describes the review as the Flex shows it: full lowercase address, raw rights, UTC date', () => {
    const d = withoutRight(held(['age_over_18', 'jurisdiction:CH']), 'age_over_18', NONCE);
    expect(flexReview(d)).toBe('agent Claude, address 0xabcdef0123456789abcdef0123456789abcdef01, can prove jurisdiction:CH, until 2025-11-01');
  });

  it('draws a fresh 32-byte nonce each time', () => {
    const a = randomNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomNonce()).not.toBe(a);
  });
});
