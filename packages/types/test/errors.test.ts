// Error and reason code contract tests. Rust matches on these exact byte values.
import { describe, expect, it } from 'vitest';
import {
  SW, REFUSAL_REASON, REFUSAL_REASON_BY_BYTE, ORANGE_REASON, BRIDGE_REASONS,
  parseRefusal, refusalReasonName, isRefusalReason,
} from '../src/index.js';

describe('status words', () => {
  it('pins the values the device and the OS return', () => {
    expect(SW.OK).toBe(0x9000);
    expect(SW.DENY).toBe(0x6985);
    expect(SW.PAYLOAD_TOO_LARGE).toBe(0xb004);
    expect(SW.NEXT_WITHOUT_FIRST).toBe(0xb00b);
    expect(SW.DEVICE_LOCKED).toBe(0x5515);
    expect(SW.CMD_NOT_ACCEPTED).toBe(0x6901);
    expect(SW.WRONG_LENGTH).toBe(0x6700);
    expect(SW.INS_NOT_SUPPORTED).toBe(0x6d00);
    expect(SW.CLA_NOT_SUPPORTED).toBe(0x6e00);
  });
});

describe('refusal reasons', () => {
  it('are the seven from the spec, numbered from 1', () => {
    expect(REFUSAL_REASON).toEqual({
      NO_POLICY: 1, NO_SESSION: 2, WRONG_CHAIN_OR_TOKEN: 3, INVALID_AMOUNT: 4,
      OVER_HARD_MAX: 5, USER_REJECTED: 6, TIMEOUT: 7,
    });
  });

  it('reserve 0, so a zeroed byte is never read as a valid reason', () => {
    expect(Object.values(REFUSAL_REASON)).not.toContain(0);
    expect(REFUSAL_REASON_BY_BYTE[0]).toBeUndefined();
  });

  it('map byte -> name consistently in both directions', () => {
    for (const [name, byte] of Object.entries(REFUSAL_REASON)) {
      expect(REFUSAL_REASON_BY_BYTE[byte]).toBe(name);
      expect(refusalReasonName(byte)).toBe(name);
    }
  });

  it('parse a 6985 response with its reason byte', () => {
    expect(parseRefusal(SW.DENY, Uint8Array.of(REFUSAL_REASON.OVER_HARD_MAX))).toBe('OVER_HARD_MAX');
    expect(parseRefusal(SW.DENY, Uint8Array.of(REFUSAL_REASON.TIMEOUT))).toBe('TIMEOUT');
  });

  it('treat a 6985 with no reason byte as USER_REJECTED rather than throwing', () => {
    expect(parseRefusal(SW.DENY, new Uint8Array(0))).toBe('USER_REJECTED');
  });

  it('reject an unknown reason byte instead of inventing a name', () => {
    expect(() => parseRefusal(SW.DENY, Uint8Array.of(99))).toThrow(/unknown refusal reason/i);
    expect(refusalReasonName(99)).toBeUndefined();
  });

  it('refuse to parse a status word that is not 6985', () => {
    expect(() => parseRefusal(SW.OK, Uint8Array.of(1))).toThrow(/6985/);
  });

  it('isRefusalReason guards the string union', () => {
    expect(isRefusalReason('TIMEOUT')).toBe(true);
    expect(isRefusalReason('FLEX_LOCKED')).toBe(false);
  });
});

describe('orange reasons', () => {
  it('are the four from the spec, in the order decide() reports them', () => {
    expect(Object.keys(ORANGE_REASON)).toEqual(['UNKNOWN_PAYEE', 'OVER_AUTO_MAX', 'BUDGET_EXCEEDED', 'COUNT_EXCEEDED']);
    expect(ORANGE_REASON).toEqual({ UNKNOWN_PAYEE: 1, OVER_AUTO_MAX: 2, BUDGET_EXCEEDED: 3, COUNT_EXCEEDED: 4 });
  });

  it('are disjoint from the refusal reasons as a string union', () => {
    for (const k of Object.keys(ORANGE_REASON)) expect(Object.keys(REFUSAL_REASON)).not.toContain(k);
  });
});

describe('bridge reasons', () => {
  it('are the device reasons plus the three transport ones', () => {
    expect(BRIDGE_REASONS).toEqual([
      'NO_POLICY', 'NO_SESSION', 'WRONG_CHAIN_OR_TOKEN', 'INVALID_AMOUNT', 'OVER_HARD_MAX',
      'USER_REJECTED', 'TIMEOUT', 'FLEX_LOCKED', 'APP_CLOSED', 'DISCONNECTED',
    ]);
  });
});
