// Signature byte order.
//
// The device returns `v | r | s` (v is 27 or 28), and our binary wire format stores that.
// viem, eth_sign and the JSON-RPC world use `r | s | v`. Converting in one tested place
// keeps the same off-by-one-byte bug out of the bridge, the server and the facilitator.
import type { Hex } from 'viem';

const SIG_HEX = 130; // 65 bytes

const body = (sig: Hex, what: string): string => {
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]+$/.test(sig)) throw new Error(`${what} must be hex`);
  const h = sig.slice(2).toLowerCase();
  if (h.length !== SIG_HEX) throw new Error(`${what} must be 65 bytes, got ${h.length / 2}`);
  return h;
};

/** Accepts 27/28 and the yParity form 0/1, and rejects anything else. */
const recoveryByte = (hexByte: string, what: string): string => {
  const v = parseInt(hexByte, 16);
  if (v === 27 || v === 28) return v.toString(16).padStart(2, '0');
  if (v === 0 || v === 1) return (v + 27).toString(16).padStart(2, '0');
  throw new Error(`${what}: ${v} is not a valid recovery byte (expected 27, 28, 0 or 1)`);
};

/** `r | s | v` (viem) -> `v | r | s` (device and wire format). */
export function toWireSignature(viemSig: Hex): Hex {
  const h = body(viemSig, 'signature');
  return `0x${recoveryByte(h.slice(128), 'recovery byte')}${h.slice(0, 128)}`;
}

/** `v | r | s` (device and wire format) -> `r | s | v` (viem). */
export function toViemSignature(wireSig: Hex): Hex {
  const h = body(wireSig, 'signature');
  return `0x${h.slice(2)}${recoveryByte(h.slice(0, 2), 'recovery byte')}`;
}

/** Splits a wire signature for the relay message, which carries v, r and s separately. */
export function splitSignature(wireSig: Hex): { v: 27 | 28; r: Hex; s: Hex } {
  const h = body(wireSig, 'signature');
  const v = parseInt(recoveryByte(h.slice(0, 2), 'recovery byte'), 16) as 27 | 28;
  return { v, r: `0x${h.slice(2, 66)}`, s: `0x${h.slice(66)}` };
}
