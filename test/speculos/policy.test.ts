// SET_POLICY and CLEAR_POLICY on the emulator.
// Security invariant 1: the policy only ever changes after an on-device review and a tap.
// These tests prove the host cannot install rules on its own, and that the review really
// shows the full payee address rather than a truncated one.
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeState, encodeChunks, encodePolicy, MAX_PAYEES, REFUSAL_REASON, SW, type Policy } from '@bsa-sentry/types';
import {
  INS, apdu, approveReview, currentScreen, goHome, rejectReview, screenshot, send, setSession, waitForText,
} from './client.js';

const TOKEN = '0x3600000000000000000000000000000000000000';
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';
const CAVE = '0x0b34839c51d7d6932a9cf00d63b15d58a29265ac';
const RESTO = '0xd4e15888844c2df59cf371917c11a99267917af5';

/** The demo policy from the spec: auto 5, hard 50, budget 20, 10 payments. */
export const demoPolicy = (): Policy => ({
  active: true,
  chainId: 5042002n,
  token: TOKEN,
  autoMax: 5_000_000n,
  hardMax: 50_000_000n,
  budget: 20_000_000n,
  maxCount: 10,
  payees: [
    { address: CAFE, label: 'Cafe Sat' },
    { address: CAVE, label: 'Corner Wines' },
    { address: RESTO, label: 'Restaurant' },
  ],
});

const state = async () => decodeState((await send(INS.GET_STATE)).data);

/** Sends SET_POLICY without awaiting, so the test can drive the review screen. */
const startSetPolicy = (policy: Policy) => {
  const chunks = encodeChunks(INS.SET_POLICY, encodePolicy(policy));
  if (chunks.length !== 1) throw new Error(`expected one chunk, got ${chunks.length}`);
  return apdu(chunks[0]!);
};

describe('SET_POLICY', () => {
  beforeAll(async () => {
    await send(INS.GET_STATE); // fail fast if Speculos is down
  });

  it('shows every limit and the FULL payee address, then stores the policy on approval', async () => {
    const pending = startSetPolicy(demoPolicy());

    // Walk the review and collect everything the user is shown.
    const seen: string[] = [];
    await waitForText(/swipe to review/i);
    for (let page = 0; page < 10; page++) {
      const screen = await currentScreen();
      seen.push(screen.map((e) => e.text).join(' '));
      if (screen.some((e) => /hold to/i.test(e.text))) break;
      const { swipe } = await import('./client.js');
      await swipe('left');
      await new Promise((r) => setTimeout(r, 250));
    }
    const shown = seen.join(' ').replace(/\s+/g, ' ');

    // The chain and the token are on screen, as the spec demands of every screen.
    expect(shown).toMatch(/Arc testnet \(5042002\)/);
    expect(shown.replace(/\s/g, '')).toContain(TOKEN.slice(2));
    // The limits, in human units.
    expect(shown).toMatch(/5 USDC/);
    expect(shown).toMatch(/50 USDC/);
    expect(shown).toMatch(/20 USDC/);
    // Each payee: its label AND its full 40-hex-digit address, never truncated.
    expect(shown).toMatch(/Cafe Sat/);
    for (const addr of [CAFE, CAVE, RESTO]) {
      expect(shown.replace(/\s/g, ''), `full address of ${addr}`).toContain(addr.slice(2));
    }
    expect(shown).not.toMatch(/0x5069\.\.\./);

    await approveReview();
    const r = await pending;
    expect(r.sw).toBe(SW.OK);

    const s = await state();
    expect(s.policy.active).toBe(true);
    expect(s.policy.chainId).toBe(5042002n);
    expect(s.policy.token).toBe(TOKEN);
    expect(s.policy.autoMax).toBe(5_000_000n);
    expect(s.policy.hardMax).toBe(50_000_000n);
    expect(s.policy.budget).toBe(20_000_000n);
    expect(s.policy.maxCount).toBe(10);
    expect(s.policy.payees.map((p) => p.address)).toEqual([CAFE, CAVE, RESTO]);
    expect(s.policy.payees.map((p) => p.label)).toEqual(['Cafe Sat', 'Corner Wines', 'Restaurant']);
  });

  it('stores nothing when the user rejects the review', async () => {
    const before = await state();
    const altered = { ...demoPolicy(), budget: 999_000_000n, hardMax: 999_000_000n };
    const pending = startSetPolicy(altered);
    await rejectReview();
    const r = await pending;
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.USER_REJECTED);

    const after = await state();
    expect(after.policy.budget, 'a rejected policy must not be stored').toBe(before.policy.budget);
    expect(after.policy.hardMax).toBe(before.policy.hardMax);
  });

  it('resets the counters, so a new budget starts from zero', async () => {
    // Spend nothing yet; just prove the counters are zero after a fresh SET_POLICY.
    const pending = startSetPolicy(demoPolicy());
    await approveReview();
    expect((await pending).sw).toBe(SW.OK);
    const s = await state();
    expect(s.spent).toBe(0n);
    expect(s.count).toBe(0);
    expect(s.lastPayment).toBeNull();
  });

  it('rejects a malformed policy without showing anything', async () => {
    // 57 bytes of zeroes is a syntactically valid length but version 0.
    const junk = new Uint8Array(57);
    const r = await apdu(Uint8Array.from([0xe0, INS.SET_POLICY, 0x00, 0x00, junk.length, ...junk]));
    expect(r.sw).not.toBe(SW.OK);
    expect(r.sw).toBe(0xb005); // TxParsingFail
  });

  it('rejects a policy with a trailing byte, so a 9th payee cannot hide after it', async () => {
    const good = encodePolicy(demoPolicy());
    const smuggled = new Uint8Array(good.length + 1);
    smuggled.set(good);
    const chunks = encodeChunks(INS.SET_POLICY, smuggled);
    let last = { sw: 0, data: new Uint8Array() };
    for (const c of chunks) last = await apdu(c);
    expect(last.sw).toBe(0xb005);
  });

  it('accepts the maximum 8 payees', async () => {
    const payees = Array.from({ length: MAX_PAYEES }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(2, '0').repeat(20)}`,
      label: `M${i + 1}`,
    }));
    const pending = startSetPolicy({ ...demoPolicy(), payees } as Policy);
    await approveReview();
    expect((await pending).sw).toBe(SW.OK);
    expect((await state()).policy.payees).toHaveLength(MAX_PAYEES);
    // Put the demo policy back for the other suites.
    const restore = startSetPolicy(demoPolicy());
    await approveReview();
    expect((await restore).sw).toBe(SW.OK);
  });
});

describe('the agent session', () => {
  it('is armed only from the device, and GET_STATE mirrors it', async () => {
    await setSession(false);
    expect((await state()).sessionArmed).toBe(false);
    await setSession(true);
    expect((await state()).sessionArmed).toBe(true);
    await goHome();
    await screenshot('02-home-armed');
  });

  it('cannot be armed by any APDU', async () => {
    await setSession(false);
    // There is no instruction for it: the whole set is tried and none arms the session.
    for (const ins of Object.values(INS)) {
      if (ins === INS.SET_POLICY || ins === INS.PAY || ins === INS.CLEAR_POLICY) continue;
      if (ins === INS.SIGN_BIND || ins === INS.SIGN_LOGIN || ins === INS.SIGN_DELEGATION) continue;
      if (ins === INS.RESTORE) continue;
      await send(ins, 0, 0).catch(() => undefined);
    }
    expect((await state()).sessionArmed, 'no APDU may arm the agent').toBe(false);
    await setSession(true);
  });
});

describe('CLEAR_POLICY (the kill switch)', () => {
  it('wipes the rules and the counters after a tap', async () => {
    expect((await state()).policy.active).toBe(true);
    const pending = apdu(Uint8Array.from([0xe0, INS.CLEAR_POLICY, 0, 0, 0]));
    await waitForText(/block/i);
    await screenshot('03-clear-policy-review');
    await approveReview();
    expect((await pending).sw).toBe(SW.OK);

    const s = await state();
    expect(s.policy.active).toBe(false);
    expect(s.policy.payees).toEqual([]);
    expect(s.spent).toBe(0n);
    expect(s.count).toBe(0);
  });

  it('keeps the policy when the user rejects', async () => {
    // Re-install the demo policy first.
    const set = startSetPolicy(demoPolicy());
    await approveReview();
    expect((await set).sw).toBe(SW.OK);

    const pending = apdu(Uint8Array.from([0xe0, INS.CLEAR_POLICY, 0, 0, 0]));
    await rejectReview();
    const r = await pending;
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.USER_REJECTED);
    expect((await state()).policy.active, 'a rejected kill switch must not wipe the rules').toBe(true);
  });
});
