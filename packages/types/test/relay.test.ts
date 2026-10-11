// Relay message schema contract tests.
// These schemas are the only thing standing between the server and the bridge tab, so they
// reject unknown fields: an unvalidated extra key is how a "hint" becomes a second payee.
import { describe, expect, it } from 'vitest';
import {
  ServerToTab, TabToServer, SignPaymentRequest, PaymentFields,
  parseServerToTab, parseTabToServer,
} from '../src/index.js';

const fields = {
  chainId: '5042002',
  token: '0x3600000000000000000000000000000000000000',
  to: '0x5069ee8f83b7181f031518d1375eae270f884175',
  value: '3000000',
  validAfter: '0',
  validBefore: '1760000600',
  nonce: `0x${'ab'.repeat(32)}`,
};

const signPayment = { id: 'req-1', type: 'sign_payment', fields, hint: 'Cafe Sat', wantCredentials: false };

describe('sign_payment', () => {
  it('parses a valid request and gives bigints for the numeric fields', () => {
    const msg = parseServerToTab(signPayment);
    expect(msg.type).toBe('sign_payment');
    if (msg.type !== 'sign_payment') throw new Error('narrowing');
    expect(msg.fields.chainId).toBe(5042002n);
    expect(msg.fields.value).toBe(3_000_000n);
    expect(msg.fields.validAfter).toBe(0n);
    expect(msg.fields.validBefore).toBe(1_760_000_600n);
    expect(msg.fields.to).toBe('0x5069ee8f83b7181f031518d1375eae270f884175');
    expect(msg.hint).toBe('Cafe Sat');
    expect(msg.wantCredentials).toBe(false);
  });

  it('accepts a request with no hint', () => {
    const { hint, ...noHint } = signPayment;
    expect(() => parseServerToTab(noHint)).not.toThrow();
  });

  it('rejects a hint over 24 bytes, the device limit', () => {
    expect(() => parseServerToTab({ ...signPayment, hint: 'x'.repeat(25) })).toThrow();
    expect(() => parseServerToTab({ ...signPayment, hint: 'x'.repeat(24) })).not.toThrow();
    // Measured in UTF-8 bytes, not codepoints, because the device stores bytes.
    expect(() => parseServerToTab({ ...signPayment, hint: '€'.repeat(9) })).toThrow(); // 27 bytes
  });

  it('rejects unknown top-level keys instead of passing them through', () => {
    expect(() => parseServerToTab({ ...signPayment, extra: 'smuggled' })).toThrow();
  });

  it('rejects unknown keys inside fields', () => {
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, from: '0x00' } })).toThrow();
  });

  it('rejects a malformed address or nonce', () => {
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, to: '0x1234' } })).toThrow();
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, nonce: '0xabcd' } })).toThrow();
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, token: 'not-hex' } })).toThrow();
  });

  it('rejects numbers that are not decimal strings, so precision can never be lost in JSON', () => {
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, value: 3000000 } })).toThrow();
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, value: '3_000_000' } })).toThrow();
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, value: '0x2dc6c0' } })).toThrow();
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, value: '-1' } })).toThrow();
  });

  it('rejects a value that does not fit in a uint256', () => {
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, value: (2n ** 256n).toString() } })).toThrow();
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, value: (2n ** 256n - 1n).toString() } })).not.toThrow();
  });

  it('rejects a chainId that does not fit in a u64, which the device parses as 8 bytes', () => {
    expect(() => parseServerToTab({ ...signPayment, fields: { ...fields, chainId: (2n ** 64n).toString() } })).toThrow();
  });

  it('requires an id so responses can be correlated', () => {
    const { id, ...noId } = signPayment;
    expect(() => parseServerToTab(noId)).toThrow();
    expect(() => parseServerToTab({ ...signPayment, id: '' })).toThrow();
  });

  it('normalises address case so the device comparison and ours agree', () => {
    const msg = parseServerToTab({ ...signPayment, fields: { ...fields, to: '0x5069EE8F83B7181F031518D1375EAE270F884175' } });
    if (msg.type !== 'sign_payment') throw new Error('narrowing');
    expect(msg.fields.to).toBe('0x5069ee8f83b7181f031518d1375eae270f884175');
  });
});

describe('get_state', () => {
  it('parses', () => {
    expect(parseServerToTab({ id: 'r2', type: 'get_state' }).type).toBe('get_state');
  });
  it('rejects extra keys', () => {
    expect(() => parseServerToTab({ id: 'r2', type: 'get_state', fields })).toThrow();
  });
  it('rejects an unknown message type', () => {
    expect(() => parseServerToTab({ id: 'r3', type: 'sign_anything' })).toThrow();
  });
});

describe('start_restore', () => {
  it('parses, and carries nothing but an id', () => {
    expect(parseServerToTab({ id: 'r', type: 'start_restore' }).type).toBe('start_restore');
    expect(() => parseServerToTab({ id: 'r', type: 'start_restore', policy: {} })).toThrow();
  });
});

describe('tab -> server responses', () => {
  const sig = { v: 27, r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}` };

  it('parses a success with a signature', () => {
    const msg = parseTabToServer({ id: 'req-1', ok: true, signature: sig });
    expect(msg).toEqual({ id: 'req-1', ok: true, signature: sig });
  });

  it('accepts v = 27 or 28 only', () => {
    expect(() => parseTabToServer({ id: 'a', ok: true, signature: { ...sig, v: 28 } })).not.toThrow();
    expect(() => parseTabToServer({ id: 'a', ok: true, signature: { ...sig, v: 0 } })).toThrow();
    expect(() => parseTabToServer({ id: 'a', ok: true, signature: { ...sig, v: 29 } })).toThrow();
  });

  it('rejects a truncated r or s', () => {
    expect(() => parseTabToServer({ id: 'a', ok: true, signature: { ...sig, r: '0x11' } })).toThrow();
  });

  it('parses a success carrying credentials', () => {
    const credentials = {
      attestation: `0x${'aa'.repeat(120)}`, attestationSig: `0x${'bb'.repeat(65)}`,
      delegation: `0x${'cc'.repeat(140)}`, delegationSig: `0x${'dd'.repeat(65)}`,
    };
    const msg = parseTabToServer({ id: 'a', ok: true, signature: sig, credentials });
    expect(msg).toEqual({ id: 'a', ok: true, signature: sig, credentials });
  });

  it('rejects a credentials bundle missing a signature', () => {
    const credentials = { attestation: `0x${'aa'.repeat(120)}`, delegation: `0x${'cc'.repeat(140)}`, delegationSig: `0x${'dd'.repeat(65)}` };
    expect(() => parseTabToServer({ id: 'a', ok: true, signature: sig, credentials })).toThrow();
  });

  it('parses every refusal reason, including the three transport ones', () => {
    for (const reason of ['NO_POLICY', 'NO_SESSION', 'WRONG_CHAIN_OR_TOKEN', 'INVALID_AMOUNT',
      'OVER_HARD_MAX', 'USER_REJECTED', 'TIMEOUT', 'FLEX_LOCKED', 'APP_CLOSED', 'DISCONNECTED']) {
      expect(parseTabToServer({ id: 'a', ok: false, reason })).toEqual({ id: 'a', ok: false, reason });
    }
  });

  it('rejects an invented reason', () => {
    expect(() => parseTabToServer({ id: 'a', ok: false, reason: 'BECAUSE' })).toThrow();
  });

  it('rejects a failure that also carries a signature', () => {
    expect(() => parseTabToServer({ id: 'a', ok: false, reason: 'TIMEOUT', signature: sig })).toThrow();
  });

  it('rejects a success with no signature', () => {
    expect(() => parseTabToServer({ id: 'a', ok: true })).toThrow();
  });
});

describe('status messages', () => {
  it('parses each Flex state', () => {
    for (const flex of ['connected', 'locked', 'app_closed', 'disconnected']) {
      expect(parseTabToServer({ type: 'status', flex, session: false })).toEqual({ type: 'status', flex, session: false });
    }
  });

  it('carries an optional hex-encoded device state blob', () => {
    const msg = parseTabToServer({ type: 'status', flex: 'connected', session: true, state: `0x${'00'.repeat(60)}` });
    expect(msg).toMatchObject({ type: 'status', flex: 'connected', session: true });
  });

  it('may carry the 0xAGENT address, lower-cased', () => {
    const msg = parseTabToServer({ type: 'status', flex: 'connected', session: true, agent: '0xAa6aBf8F8c5F003A69D26d12d5a625Da77e2D9bF' });
    expect(msg).toMatchObject({ agent: '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' });
    expect(() => parseTabToServer({ type: 'status', flex: 'connected', session: true, agent: '0x1234' })).toThrow();
  });

  it('rejects an unknown Flex state', () => {
    expect(() => parseTabToServer({ type: 'status', flex: 'exploded', session: false })).toThrow();
  });

  it('has no id, because it is unsolicited', () => {
    expect(() => parseTabToServer({ type: 'status', flex: 'connected', session: true, id: 'x' })).toThrow();
  });
});

describe('schemas are exported for reuse', () => {
  it('exposes the building blocks', () => {
    expect(PaymentFields.safeParse(fields).success).toBe(true);
    expect(SignPaymentRequest.safeParse(signPayment).success).toBe(true);
    expect(ServerToTab.safeParse(signPayment).success).toBe(true);
    expect(TabToServer.safeParse({ type: 'status', flex: 'locked', session: false }).success).toBe(true);
  });

  it('parse helpers throw with a readable message', () => {
    expect(() => parseServerToTab({ nope: 1 })).toThrow(/relay message/i);
    expect(() => parseTabToServer({ nope: 1 })).toThrow(/relay message/i);
  });
});
