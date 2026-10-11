// Signature byte order. The device returns v | r | s (and our wire format stores that),
// while viem and the JSON-RPC world use r | s | v. Converting in one tested place stops
// the same off-by-one-byte bug appearing in the bridge, the server and the facilitator.
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { toViemSignature, toWireSignature, splitSignature } from '../src/index.js';

const R = 'aa'.repeat(32);
const S = 'bb'.repeat(32);

describe('conversion', () => {
  it('moves v from the end to the front', () => {
    expect(toWireSignature(`0x${R}${S}1b`)).toBe(`0x1b${R}${S}`);
    expect(toWireSignature(`0x${R}${S}1c`)).toBe(`0x1c${R}${S}`);
  });

  it('moves v from the front to the end', () => {
    expect(toViemSignature(`0x1b${R}${S}`)).toBe(`0x${R}${S}1b`);
  });

  it('round-trips both ways', () => {
    const viem = `0x${R}${S}1c` as const;
    expect(toViemSignature(toWireSignature(viem))).toBe(viem);
    const wire = `0x1b${R}${S}` as const;
    expect(toWireSignature(toViemSignature(wire))).toBe(wire);
  });

  it('normalises a yParity of 0 or 1 to 27 or 28', () => {
    expect(toWireSignature(`0x${R}${S}00`)).toBe(`0x1b${R}${S}`);
    expect(toWireSignature(`0x${R}${S}01`)).toBe(`0x1c${R}${S}`);
  });

  it('rejects a signature that is not 65 bytes', () => {
    expect(() => toWireSignature(`0x${R}${S}`)).toThrow(/65 bytes/i);
    expect(() => toViemSignature(`0x1b${R}`)).toThrow(/65 bytes/i);
  });

  it('rejects an impossible recovery byte rather than guessing', () => {
    expect(() => toWireSignature(`0x${R}${S}07`)).toThrow(/recovery/i);
    expect(() => toViemSignature(`0x07${R}${S}`)).toThrow(/recovery/i);
  });

  it('splits a wire signature into v, r and s for the relay message', () => {
    expect(splitSignature(`0x1c${R}${S}`)).toEqual({ v: 28, r: `0x${R}`, s: `0x${S}` });
  });

  it('rejects a wire signature whose first byte is not a recovery byte', () => {
    // This is exactly the bug the helpers exist to prevent: handing viem's r|s|v
    // to something expecting v|r|s.
    expect(() => splitSignature(`0x${R}${S}1b`)).toThrow(/recovery/i);
  });
});

describe('against a real signature', () => {
  it('a viem signature converted to wire order recovers to the same signer', async () => {
    const account = privateKeyToAccount(`0x${'42'.repeat(32)}`);
    const message = 'bsa sentry';
    const viemSig = await account.signMessage({ message });
    const wire = toWireSignature(viemSig);
    expect(wire.slice(0, 4)).toMatch(/^0x1[bc]$/);
    const recovered = await recoverMessageAddress({ message, signature: toViemSignature(wire) });
    expect(recovered).toBe(account.address);
  });
});
