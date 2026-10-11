// APDU framing and the chunked-transfer state machine.
//
// Wire format, proven on the Flex: CLA 0xE0, P1 0x00 first / 0x01 next,
// P2 0x80 more / 0x00 last. The device reassembles up to 1024 bytes and answers
// 0xB004 beyond that, or 0xB00B for a "next" without a "first".
import { ApduError, SW } from './errors.js';
import { concat } from './policy.js';

export const CLA = 0xe0;

/** Chunked commands and their boundaries are the reason M0 pins 0 / 250 / 251 / 1024 / 1025. */
export const MAX_APDU_DATA = 250;
export const MAX_REASSEMBLY = 1024;

export const P1_FIRST = 0x00;
export const P1_NEXT = 0x01;
export const P2_MORE = 0x80;
export const P2_LAST = 0x00;

/**
 * The BSA Sentry instruction set. Note what is absent: the feasibility app's PING (0x07),
 * SIGN_3009 (0x09) and SIGN_3009_SILENT (0x0F, no policy and no tap). Security invariant 2
 * and 4 depend on them not existing.
 */
export const INS = {
  GET_ADDRESS: 0x08,
  SET_POLICY: 0x0a,
  PAY: 0x0b,
  GET_STATE: 0x0c,
  CLEAR_POLICY: 0x0d,
  SIGN_BIND: 0x0e,
  SIGN_LOGIN: 0x0f,
  SIGN_DELEGATION: 0x10,
  STORE_CREDENTIALS: 0x11,
  GET_CREDENTIALS: 0x12,
  RESTORE: 0x13,
} as const;

export type Ins = (typeof INS)[keyof typeof INS];

/** Splits a payload into complete APDUs. A zero-length payload still sends one APDU. */
export function encodeChunks(ins: number, payload: Uint8Array, cla = CLA): Uint8Array[] {
  if (payload.length > MAX_REASSEMBLY) {
    throw new Error(`payload is ${payload.length} bytes; the device reassembly buffer is ${MAX_REASSEMBLY}`);
  }
  const out: Uint8Array[] = [];
  let offset = 0;
  let first = true;
  do {
    const data = payload.subarray(offset, offset + MAX_APDU_DATA);
    offset += data.length;
    const last = offset >= payload.length;
    const apdu = new Uint8Array(5 + data.length);
    apdu[0] = cla;
    apdu[1] = ins;
    apdu[2] = first ? P1_FIRST : P1_NEXT;
    apdu[3] = last ? P2_LAST : P2_MORE;
    apdu[4] = data.length;
    apdu.set(data, 5);
    out.push(apdu);
    first = false;
  } while (offset < payload.length);
  return out;
}

/** Host-side inverse of encodeChunks, used by tests and the harness. */
export function decodeChunks(apdus: readonly Uint8Array[]): { ins: number; payload: Uint8Array } {
  if (apdus.length === 0) throw new Error('no APDU to decode');
  const ins = apdus[0]![1]!;
  const parts: Uint8Array[] = [];
  apdus.forEach((a, i) => {
    if (a.length < 5) throw new Error(`APDU ${i} is shorter than a header`);
    if (a[1] !== ins) throw new Error(`every chunk must carry the same INS (chunk ${i})`);
    const lc = a[4]!;
    if (a.length !== 5 + lc) throw new Error(`APDU ${i} Lc says ${lc} but carries ${a.length - 5} bytes`);
    const shouldBeLast = i === apdus.length - 1;
    if (shouldBeLast !== (a[3] === P2_LAST)) {
      throw new Error(`chunk ${i}: only the final chunk may be marked last`);
    }
    parts.push(a.subarray(5));
  });
  return { ins, payload: concat(parts) };
}

/**
 * Device-side reassembly, mirrored here so host tests cover the same state machine.
 * `push` returns the payload on the final chunk and `null` while more are expected.
 */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private length = 0;
  private started = false;

  push(p1: number, p2: number, data: Uint8Array): Uint8Array | null {
    if (p1 !== P1_FIRST && p1 !== P1_NEXT) throw new Error(`unknown P1 0x${p1.toString(16)}`);
    if (p2 !== P2_MORE && p2 !== P2_LAST) throw new Error(`unknown P2 0x${p2.toString(16)}`);
    if (data.length > MAX_APDU_DATA) throw new Error(`chunk is ${data.length} bytes, the maximum is ${MAX_APDU_DATA}`);

    if (p1 === P1_FIRST) {
      // A new transfer always discards whatever was in flight, so an abandoned
      // transfer can never be concatenated onto a later one.
      this.parts = [];
      this.length = 0;
      this.started = true;
    } else if (!this.started) {
      throw new ApduError(SW.NEXT_WITHOUT_FIRST, 'received a "next" chunk without a "first"');
    }

    if (this.length + data.length > MAX_REASSEMBLY) {
      this.reset();
      throw new ApduError(SW.PAYLOAD_TOO_LARGE, `payload would exceed ${MAX_REASSEMBLY} bytes`);
    }
    this.parts.push(Uint8Array.from(data));
    this.length += data.length;

    if (p2 === P2_LAST) {
      const payload = concat(this.parts);
      this.reset();
      return payload;
    }
    return null;
  }

  private reset() {
    this.parts = [];
    this.length = 0;
    this.started = false;
  }
}
