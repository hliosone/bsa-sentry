// Driving the Speculos UI: screens, taps, swipes and the review flows.
//
// Shared by the integration tests, `scripts/device-smoke.ts` and the e2e scripts, so the
// gestures are defined once. Every target is located from the device's own `/events`
// output rather than hardcoded pixels: a layout change then fails loudly instead of
// quietly tapping nothing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API = () => process.env.SPECULOS_API ?? 'http://localhost:5000';
const REPO = resolve(import.meta.dirname, '..');

export type ScreenEvent = { text: string; x: number; y: number; w: number; h: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown, timeoutMs = 10_000) {
  const res = await fetch(`${API()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** Only what is on screen right now. */
export async function currentScreen(): Promise<ScreenEvent[]> {
  const res = await fetch(`${API()}/events?currentscreenonly=true`, { signal: AbortSignal.timeout(5_000) });
  const json = (await res.json()) as { events: ScreenEvent[] };
  return json.events ?? [];
}

/** Screen text with NBGL's line wrapping collapsed, for matching. */
export const screenText = async () =>
  (await currentScreen()).map((e) => e.text).join(' ').replace(/\s+/g, ' ');

export async function tapAt(x: number, y: number) {
  await post('/finger', { action: 'press-and-release', x, y });
}

/** Taps the centre of whichever element matches, so the coordinates come from the device. */
export async function tapText(match: string | RegExp): Promise<ScreenEvent> {
  const re = typeof match === 'string' ? new RegExp(escapeRe(match), 'i') : match;
  const screen = await currentScreen();
  const hit = screen.find((e) => re.test(e.text));
  if (!hit) throw new Error(`no element matching ${re}. Screen: ${screen.map((e) => e.text).join(' | ')}`);
  await tapAt(Math.round(hit.x + hit.w / 2), Math.round(hit.y + hit.h / 2));
  return hit;
}

/**
 * Swipes. Speculos' `press-and-release` takes an optional release point (`x2`/`y2`), which
 * is how a drag is expressed - undocumented, found in `speculos/api/finger.py`.
 * Flex reviews are paged by swiping, not tapping.
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

/** Presses and holds, for the "hold to sign" button that ends every review. */
export async function hold(x: number, y: number, ms = 3000) {
  await post('/finger', { action: 'press', x, y });
  await sleep(ms);
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
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${re}. Last screen: ${last}`);
}

/** Saves the current screen into docs/screens/speculos/, for Phase C and the submission. */
export async function screenshot(name: string) {
  const res = await fetch(`${API()}/screenshot`, { signal: AbortSignal.timeout(5_000) });
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

// ---------------------------------------------------------------- review flows
//
// Flex reviews are paged by SWIPING and confirmed by HOLDING the final button.

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
  const confirm = (await currentScreen()).find((e) => /yes, reject|reject transaction|oui/i.test(e.text));
  if (confirm) {
    await tapAt(Math.round(confirm.x + confirm.w / 2), Math.round(confirm.y + confirm.h / 2));
    await sleep(400);
  }
}

// ---------------------------------------------------------------- the session switch
//
// The agent session is switch 0 on the home screen's settings page. It is the only way to
// arm the agent, by design: no APDU can do it.

const SETTINGS_GEAR = { x: 430, y: 50 };
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

/** Flips the switch on the device and verifies it took effect through `isArmed`. */
export async function setSessionVia(isArmed: () => Promise<boolean>, on: boolean) {
  if ((await isArmed()) === on) return;
  await openSettings();
  await tapAt(SESSION_SWITCH.x, SESSION_SWITCH.y);
  await sleep(400);
  const now = await isArmed();
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
