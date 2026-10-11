// Test-side helpers for the Speculos integration suite.
//
// The UI driver (screens, taps, swipes, review flows, the session switch) lives in
// `scripts/speculos-ui.ts` so that the smoke script and the e2e scripts drive the device
// exactly the way the tests do. This file adds the APDU plumbing the tests need.
import { decodeState } from '@bsa-sentry/types';
import { setSessionVia } from '../../scripts/speculos-ui.js';

export {
  approveReview, currentScreen, goHome, hold, openSettings, rejectReview, restart,
  screenshot, screenText, swipe, tapAt, tapText, waitForText, type ScreenEvent,
} from '../../scripts/speculos-ui.js';

const API = () => process.env.SPECULOS_API ?? 'http://localhost:5000';

/** The device may hold a screen for 60 s, so every call must outlive that. */
const APDU_TIMEOUT_MS = 125_000;

export type ApduResult = { data: Uint8Array; sw: number };

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s: string) =>
  Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (x) => parseInt(x, 16));

/** Sends one APDU. Never throws on a non-9000 status word: the caller asserts on it. */
export async function apdu(bytes: Uint8Array | string): Promise<ApduResult> {
  const data = typeof bytes === 'string' ? bytes.replace(/^0x/, '') : hex(bytes);
  const res = await fetch(`${API()}/apdu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(APDU_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`/apdu -> HTTP ${res.status}`);
  const json = (await res.json()) as { data: string };
  const raw = unhex(json.data);
  if (raw.length < 2) throw new Error(`short APDU response: ${json.data}`);
  return { data: raw.subarray(0, raw.length - 2), sw: (raw[raw.length - 2]! << 8) | raw[raw.length - 1]! };
}

/** Builds and sends a single (unchunked) APDU. */
export const send = (ins: number, p1 = 0, p2 = 0, data = new Uint8Array(0)) =>
  apdu(Uint8Array.from([0xe0, ins, p1, p2, data.length, ...data]));

export const INS = {
  GET_VERSION: 0x03,
  GET_APP_NAME: 0x04,
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

/** Arms or disarms the agent through the device UI, reading the truth back from GET_STATE. */
export const setSession = (on: boolean) =>
  setSessionVia(async () => decodeState((await send(INS.GET_STATE)).data).sessionArmed, on);

/** The 176-byte PAY payload, plus the agent's hint. */
export function payPayload(f: {
  chainId: bigint; token: string; to: string; value: bigint;
  validAfter?: bigint; validBefore?: bigint; nonce?: string; hint?: string;
}): Uint8Array {
  const be = (v: bigint, bytes: number) => {
    const out = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) out[i] = Number((v >> BigInt((bytes - 1 - i) * 8)) & 0xffn);
    return out;
  };
  const hint = new TextEncoder().encode(f.hint ?? '');
  if (hint.length > 24) throw new Error('hint must be at most 24 UTF-8 bytes');
  const parts = [
    be(f.chainId, 8), unhex(f.token), unhex(f.to), be(f.value, 32),
    be(f.validAfter ?? 0n, 32), be(f.validBefore ?? 2n ** 32n, 32),
    f.nonce ? unhex(f.nonce) : new Uint8Array(32), hint,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
