// Thin client for the Speculos REST API.
//
// M1 talks to the emulator over plain HTTP rather than through sentry-signer: that package is
// M2's job, and keeping the device tests independent of it means a bug in one cannot hide a
// bug in the other. The transport is the only difference; the APDUs are identical.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API = process.env.SPECULOS_API ?? 'http://localhost:5000';
const REPO = resolve(import.meta.dirname, '../..');

/** The device may hold a screen for 60 s, so every call must outlive that (proven: >= 120 s). */
const APDU_TIMEOUT_MS = 125_000;

export type ApduResult = { data: Uint8Array; sw: number };

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s: string) => Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (x) => parseInt(x, 16));

async function post(path: string, body: unknown, timeoutMs = 10_000) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** Sends one APDU. Never throws on a non-9000 status word: the caller asserts on it. */
export async function apdu(bytes: Uint8Array | string): Promise<ApduResult> {
  const data = typeof bytes === 'string' ? bytes.replace(/^0x/, '') : hex(bytes);
  const json = (await post('/apdu', { data }, APDU_TIMEOUT_MS)) as { data: string };
  const raw = unhex(json.data);
  if (raw.length < 2) throw new Error(`short APDU response: ${json.data}`);
  return { data: raw.subarray(0, raw.length - 2), sw: (raw[raw.length - 2]! << 8) | raw[raw.length - 1]! };
}

/** Builds and sends a single (unchunked) APDU. */
export const send = (ins: number, p1 = 0, p2 = 0, data = new Uint8Array(0)) =>
  apdu(Uint8Array.from([0xe0, ins, p1, p2, data.length, ...data]));

export type ScreenEvent = { text: string; x: number; y: number; w: number; h: number };

/** Everything drawn since the last `/events?currentscreenonly=false` reset. */
export async function events(): Promise<ScreenEvent[]> {
  const res = await fetch(`${API}/events`, { signal: AbortSignal.timeout(5_000) });
  const json = (await res.json()) as { events: ScreenEvent[] };
  return json.events ?? [];
}

/** Only what is on screen right now. */
export async function currentScreen(): Promise<ScreenEvent[]> {
  const res = await fetch(`${API}/events?currentscreenonly=true`, { signal: AbortSignal.timeout(5_000) });
  const json = (await res.json()) as { events: ScreenEvent[] };
  return json.events ?? [];
}

export const screenText = async () => (await currentScreen()).map((e) => e.text).join(' | ');

/**
 * Taps the centre of the element whose text matches, instead of hardcoded pixels: the
 * coordinates come from the device's own layout, so a UI tweak does not silently
 * start tapping the wrong button.
 */
export async function tapText(match: string | RegExp): Promise<ScreenEvent> {
  const re = typeof match === 'string' ? new RegExp(escapeRe(match), 'i') : match;
  const screen = await currentScreen();
  const hit = screen.find((e) => re.test(e.text));
  if (!hit) throw new Error(`no element matching ${re} on screen. Screen was: ${screen.map((e) => e.text).join(' | ')}`);
  await tapAt(Math.round(hit.x + hit.w / 2), Math.round(hit.y + hit.h / 2));
  return hit;
}

export async function tapAt(x: number, y: number) {
  await post('/finger', { action: 'press-and-release', x, y });
}

/**
 * Swipes. Speculos' `press-and-release` takes an optional release point, which is how a
 * drag is expressed; Flex reviews are paged by swiping, not tapping.
 */
export async function swipe(dir: 'left' | 'right' | 'up' | 'down' = 'left') {
  const mid = { x: 240, y: 300 };
  const span = 180;
  const to = {
    left: { x: mid.x - span, y: mid.y },
    right: { x: mid.x + span, y: mid.y },
    up: { x: mid.x, y: mid.y - span },
    down: { x: mid.x, y: mid.y + span },
  }[dir];
  await post('/finger', { action: 'press-and-release', x: mid.x, y: mid.y, x2: to.x, y2: to.y, delay: 0.2 });
}

/** Presses and holds, for the "hold to approve" button at the end of a review. */
export async function hold(x: number, y: number, ms = 3000) {
  await post('/finger', { action: 'press', x, y });
  await new Promise((r) => setTimeout(r, ms));
  await post('/finger', { action: 'release', x, y });
}

/** Polls until an element matching `match` is on screen, or the deadline passes. */
export async function waitForText(match: string | RegExp, timeoutMs = 15_000): Promise<ScreenEvent> {
  const re = typeof match === 'string' ? new RegExp(escapeRe(match), 'i') : match;
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const screen = await currentScreen();
    const hit = screen.find((e) => re.test(e.text));
    if (hit) return hit;
    last = screen.map((e) => e.text).join(' | ');
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${re}. Last screen: ${last}`);
}

/** Saves the current screen into docs/screens/speculos/, for the submission and Phase C. */
export async function screenshot(name: string) {
  const res = await fetch(`${API}/screenshot`, { signal: AbortSignal.timeout(5_000) });
  const buf = Buffer.from(await res.arrayBuffer());
  const path = resolve(REPO, 'docs/screens/speculos', `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  return path;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Restarts the emulator. `fresh` wipes the emulated NVM, for the restore tests. */
export function restart(fresh = false) {
  execFileSync(resolve(REPO, 'scripts/speculos.sh'), ['restart', ...(fresh ? ['--fresh'] : [])], {
    cwd: REPO,
    stdio: 'pipe',
  });
}

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

// ---------------------------------------------------------------- review flows
//
// Flex reviews are paged by SWIPING, not tapping, and confirmed by HOLDING the
// "Hold to sign" button. Learned empirically from /events rather than hardcoded, so a
// layout change shows up as a clear failure instead of a tap landing on nothing.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Swipes to the last page of a review and holds to approve. */
export async function approveReview(maxPages = 12) {
  await waitForText(/swipe to review|hold to/i);
  for (let i = 0; i < maxPages; i++) {
    const screen = await currentScreen();
    const holdBtn = screen.find((e) => /hold to/i.test(e.text));
    if (holdBtn) {
      await hold(Math.round(holdBtn.x + holdBtn.w / 2), Math.round(holdBtn.y + holdBtn.h / 2), 3000);
      return;
    }
    await swipe('left');
    await sleep(250);
  }
  throw new Error(`never reached the hold-to-sign page. Screen: ${await screenText()}`);
}

/** Taps Reject, then confirms if the device asks. */
export async function rejectReview() {
  await waitForText(/reject|refuser/i);
  await tapText(/^reject$|^refuser$/i);
  await sleep(400);
  // Flex asks for confirmation on reject; approve that confirmation if it appears.
  const screen = await currentScreen();
  const confirm = screen.find((e) => /yes, reject|reject transaction|oui/i.test(e.text));
  if (confirm) {
    await tapAt(Math.round(confirm.x + confirm.w / 2), Math.round(confirm.y + confirm.h / 2));
    await sleep(400);
  }
}

// ---------------------------------------------------------------- the session switch
//
// The agent session is switch 0 on the home screen's settings page. It is the only way to
// arm the agent, by design: the host cannot do it.

/** Top-right of the home screen opens the settings pages. */
const SETTINGS_GEAR = { x: 430, y: 50 };
/** The switch control sits at the right end of its row. */
const SESSION_SWITCH = { x: 420, y: 140 };

export async function openSettings() {
  await tapAt(SETTINGS_GEAR.x, SETTINGS_GEAR.y);
  await sleep(500);
  // The settings pager remembers where it was left, so walk back to the first page.
  for (let i = 0; i < 4; i++) {
    if ((await currentScreen()).some((e) => /agent session/i.test(e.text))) return;
    await swipe('right');
    await sleep(300);
  }
  throw new Error(`could not reach the Agent session page. Screen: ${await screenText()}`);
}

/** Arms or disarms the agent through the device UI, and verifies it took effect. */
export async function setSession(on: boolean) {
  const { decodeState } = await import('@bsa-sentry/types');
  const current = () => send(INS.GET_STATE).then((r) => decodeState(r.data).sessionArmed);
  if ((await current()) === on) return;
  await openSettings();
  await tapAt(SESSION_SWITCH.x, SESSION_SWITCH.y);
  await sleep(400);
  const now = await current();
  if (now !== on) throw new Error(`failed to ${on ? 'arm' : 'disarm'} the session (still ${now})`);
}

/** Leaves the settings pages. The back arrow is top-left. */
export async function goHome() {
  for (let i = 0; i < 3; i++) {
    if ((await currentScreen()).some((e) => /quit app/i.test(e.text))) return;
    await tapAt(36, 36);
    await sleep(400);
  }
}

// ---------------------------------------------------------------- payload builders

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
  const addr = (a: string) => unhex(a);
  const hint = new TextEncoder().encode(f.hint ?? '');
  if (hint.length > 24) throw new Error('hint must be at most 24 UTF-8 bytes');
  const parts = [
    be(f.chainId, 8), addr(f.token), addr(f.to), be(f.value, 32),
    be(f.validAfter ?? 0n, 32), be(f.validBefore ?? 2n ** 32n, 32),
    f.nonce ? unhex(f.nonce) : new Uint8Array(32), hint,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
