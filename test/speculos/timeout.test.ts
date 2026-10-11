// The orange screen denies by default. This is the one test that has to spend real wall
// clock: the device counts 600 raw ticker events at 100 ms each, and the whole point is
// that no host and no missing user can turn that into an approval.
//
// Separate file so `pnpm test:speculos` stays quick to iterate on; it is included in the
// full run and in `pnpm e2e`.
import { describe, expect, it } from 'vitest';
import { encodeChunks, encodePolicy, REFUSAL_REASON, SW, type Policy } from '@bsa-sentry/types';
import { INS, apdu, approveReview, payPayload, screenshot, setSession, waitForText } from './client.js';

const TOKEN = '0x3600000000000000000000000000000000000000';
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';
const STRANGER = '0xdd70bd3cde251346c0ddfc7a4db3056bb26f1e50';
const ARC = 5042002n;
const USDC = 1_000_000n;

const policy: Policy = {
  active: true, chainId: ARC, token: TOKEN,
  autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [{ address: CAFE, label: 'Cafe Sat' }],
};

describe('the orange screen refuses on its own after 60 s', () => {
  it('times out with USER_REJECTED and spends nothing', { timeout: 150_000 }, async () => {
    const chunks = encodeChunks(INS.SET_POLICY, encodePolicy(policy));
    const set = apdu(chunks[0]!);
    await approveReview();
    expect((await set).sw).toBe(SW.OK);
    await setSession(true);

    const data = payPayload({
      chainId: ARC, token: TOKEN, to: STRANGER, value: 2n * USDC,
      validAfter: 0n, validBefore: 4_000_000_000n, nonce: `0x${'aa'.repeat(32)}`, hint: 'Patient',
    });
    const started = Date.now();
    const pending = apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, data.length, ...data]));
    await waitForText(/Payer/i);
    await screenshot('11-orange-before-timeout');

    // Touch nothing at all.
    const r = await pending;
    const elapsed = (Date.now() - started) / 1000;

    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.USER_REJECTED);
    // 600 ticks of 100 ms, measured at ~63.8 s of wall clock on real hardware. The bound
    // that matters is the lower one: it must never refuse early and surprise a user who
    // was still reading.
    expect(elapsed, `timed out after ${elapsed}s`).toBeGreaterThan(55);
    expect(elapsed).toBeLessThan(120);

    // And the device is usable immediately afterwards: no desync, no stuck screen.
    const { decodeState } = await import('@bsa-sentry/types');
    const { send } = await import('./client.js');
    const state = decodeState((await send(INS.GET_STATE)).data);
    expect(state.spent, 'a timeout must not spend').toBe(0n);
    expect(state.count).toBe(0);
    expect(state.policy.payees, 'a timeout must not add a payee').toHaveLength(1);
  });
});
