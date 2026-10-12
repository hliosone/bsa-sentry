// The device's own home screen and menu: what the user sees and can do on the Flex without
// any website or server. The kill switch in particular must live HERE, because it exists for
// the moment the website or the server can no longer be trusted.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decodeState, encodeChunks, encodePolicy, SW, type Policy } from '@bsa-sentry/types';
import {
  INS, apdu, approveReview, currentScreen, goHome, payPayload, restart, screenText, screenshot, send,
  setSession, swipe, tapAt, tapText, waitForText,
} from './client.js';

const TOKEN = '0x3600000000000000000000000000000000000000';
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';
const CAVE = '0x0b34839c51d7d6932a9cf00d63b15d58a29265ac';
const USDC = 1_000_000n;
const policy: Policy = {
  active: true, chainId: 5042002n, token: TOKEN, autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [{ address: CAFE, label: 'Cafe Sat' }, { address: CAVE, label: 'Corner Wines' }],
};
const state = async () => decodeState((await send(INS.GET_STATE)).data);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function install() {
  const set = apdu(encodeChunks(INS.SET_POLICY, encodePolicy(policy))[0]!);
  await approveReview();
  expect((await set).sw).toBe(SW.OK);
}

/** Opens the settings pages and swipes until an element matching `re` is on screen. */
async function openMenuPage(re: RegExp) {
  await goHome();
  await tapAt(430, 50);
  await sleep(500);
  for (let i = 0; i < 6; i++) {
    if ((await currentScreen()).some((e) => re.test(e.text))) return;
    await swipe('left');
    await sleep(350);
  }
  throw new Error(`menu page ${re} not found. Screen: ${await screenText()}`);
}

beforeAll(() => restart(true));

describe('the home screen', () => {
  beforeEach(async () => { await install(); await goHome(); });

  it('shows the budget, the chain and token, and the session state', async () => {
    await setSession(false);
    await goHome();
    const t = await screenText();
    expect(t).toMatch(/BSA Sentry/);
    expect(t).toMatch(/20(\.00)? \/ 20(\.00)? USDC/);
    expect(t).toMatch(/Arc testnet/);
    expect(t).toMatch(/session off/i);
    await screenshot('15-home-with-rules');
  });

  it('updates after a payment: remaining budget and the last payment', async () => {
    await setSession(true);
    const data = payPayload({ chainId: 5042002n, token: TOKEN, to: CAFE, value: 3n * USDC, hint: 'Cafe Sat', nonce: `0x${'71'.repeat(32)}` });
    expect((await apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, data.length, ...data]))).sw).toBe(SW.OK);
    await goHome();
    const t = await screenText();
    expect(t).toMatch(/17(\.00)? \/ 20(\.00)? USDC/);
    expect(t).toMatch(/Cafe Sat 3/);
    expect(t).toMatch(/session on/i);
    await screenshot('16-home-after-coffee');
  });

  it('says plainly when there are no rules', async () => {
    restart(true);
    await goHome();
    expect(await screenText()).toMatch(/No rules/i);
    await install();
  });
});

describe('the menu', () => {
  beforeEach(async () => { await install(); });

  it('shows my rules', async () => {
    await openMenuPage(/Hard limit/i);
    const t = await screenText();
    expect(t).toMatch(/5 USDC/);
    expect(t).toMatch(/50 USDC/);
    expect(t).toMatch(/20 USDC/);
    await screenshot('17-menu-rules');
  });

  it('removes a trusted merchant after a confirmation, by address', async () => {
    await openMenuPage(/Corner Wines/);
    await screenshot('18-menu-merchants');
    await tapText(/Corner Wines/);
    await waitForText(/^Yes, remove$/);
    // The confirmation names the full address, not just the label.
    expect((await screenText()).replace(/\s/g, '')).toContain(CAVE.slice(2, 22));
    await tapText(/^Yes, remove$/);
    await sleep(600);
    expect((await state()).policy.payees.map((p) => p.address)).toEqual([CAFE]);
  });

  it('keeps the merchant when the removal is cancelled', async () => {
    await openMenuPage(/Corner Wines/);
    await tapText(/Corner Wines/);
    await waitForText(/^Cancel$/);
    await tapText(/^Cancel$/);
    await sleep(600);
    expect((await state()).policy.payees).toHaveLength(2);
  });

  it('+20 USDC: resets the spent budget after a confirmation', async () => {
    await setSession(true);
    const data = payPayload({ chainId: 5042002n, token: TOKEN, to: CAFE, value: 4n * USDC, nonce: `0x${'72'.repeat(32)}` });
    await apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, data.length, ...data]));
    expect((await state()).spent).toBe(4n * USDC);
    await openMenuPage(/\+20 USDC/);
    await tapText(/\+20 USDC/);
    await waitForText(/^Yes, reset/);
    await tapText(/^Yes, reset/);
    await sleep(600);
    const s = await state();
    expect(s.spent).toBe(0n);
    expect(s.policy.active, 'the rules themselves are untouched').toBe(true);
  });

  it('blocks the agent from the device itself: rules and merchants wiped after a confirmation', async () => {
    await openMenuPage(/Block agent/);
    await screenshot('19-menu-actions');
    await tapText(/Block agent/);
    await waitForText(/^Yes, block$/);
    await screenshot('20-menu-block-confirm');
    await tapText(/^Yes, block$/);
    await sleep(700);
    const s = await state();
    expect(s.policy.active).toBe(false);
    expect(s.policy.payees).toEqual([]);
    // And payments are refused from now on.
    const data = payPayload({ chainId: 5042002n, token: TOKEN, to: CAFE, value: USDC, nonce: `0x${'73'.repeat(32)}` });
    const r = await apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, data.length, ...data]));
    expect(r.sw).toBe(SW.DENY);
  });

  it('the agent session switch still arms and disarms, RAM only', async () => {
    await setSession(true);
    expect((await state()).sessionArmed).toBe(true);
    // Speculos cannot keep a Rust app's NVM across a restart ("not yet implemented for Rust
    // apps"), so that the rules survive is checked on the Flex in Phase C, not here.
    restart(false);
    expect((await state()).sessionArmed, 'a restart always disarms').toBe(false);
  });
});

describe('GET_ADDRESS with P2 = 1 shows the address on the device', () => {
  it('displays the full agent address and answers once the user confirms', async () => {
    const silent = await apdu('e008010000');
    const pending = apdu('e008010100');
    await waitForText(/Agent address/);
    await screenshot('21-show-address');
    await swipe('left');
    await waitForText(/^Confirm$/);
    // The FULL address, as the device derives it.
    expect((await screenText()).replace(/\s/g, '')).toContain(`0x${Buffer.from(silent.data).toString('hex')}`);
    await tapText(/^Confirm$/);
    const r = await pending;
    expect(r.sw).toBe(SW.OK);
    expect(r.data).toEqual(silent.data);
  });

  it('answers DENY when the user cancels', async () => {
    const pending = apdu('e008000100');
    await waitForText(/Your main/);
    await tapText(/^Cancel$/);
    expect((await pending).sw).toBe(SW.DENY);
  });
});
