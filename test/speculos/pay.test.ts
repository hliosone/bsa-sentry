// PAY — the whole product.
//   inside the rules  -> signs with NO button press
//   outside the rules -> orange screen, 3 choices, 60 s then refuse
//   dangerous         -> refused, and a tap cannot override it
//
// Every signature is verified with viem against the EIP-712 digest and 0xAGENT's address,
// so a "signature" that does not actually authorise the payment cannot pass.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { recoverTypedDataAddress } from 'viem';
import {
  EIP712_TYPES, decodeState, encodeChunks, encodePolicy, paymentDomain, REFUSAL_REASON, SW, type Policy,
} from '@bsa-sentry/types';
import {
  INS, apdu, approveReview, currentScreen, payPayload, rejectReview, screenshot, send, setSession,
  tapText, waitForText, hex,
} from './client.js';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

const TOKEN = '0x3600000000000000000000000000000000000000';
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';
const CAVE = '0x0b34839c51d7d6932a9cf00d63b15d58a29265ac';
const RESTO = '0xd4e15888844c2df59cf371917c11a99267917af5';
const STRANGER = '0xdd70bd3cde251346c0ddfc7a4db3056bb26f1e50';
const ARC = 5042002n;
const USDC = 1_000_000n;

const demoPolicy = (): Policy => ({
  active: true, chainId: ARC, token: TOKEN,
  autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [
    { address: CAFE, label: 'Cafe Sat' },
    { address: CAVE, label: 'Cave du Coin' },
    { address: RESTO, label: 'Resto' },
  ],
});

const state = async () => decodeState((await send(INS.GET_STATE)).data);

/** Screen text with wrapping collapsed: NBGL splits long lines into separate elements. */
const flat = async () => (await currentScreen()).map((e) => e.text).join(' ').replace(/\s+/g, ' ');

/**
 * Safety net between tests. If a previous test left a review or an orange screen up, the
 * device is still blocked and the next APDU would come back 0x6901, so dismiss it.
 */
async function dismissAnyModal() {
  const shown = await flat();
  if (/Payer .* \?/.test(shown)) {
    await tapText('Refuser').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
  } else if (/swipe to review|hold to sign/i.test(shown)) {
    await rejectReview().catch(() => undefined);
  }
}

async function installPolicy(policy: Policy = demoPolicy()) {
  const chunks = encodeChunks(INS.SET_POLICY, encodePolicy(policy));
  const pending = apdu(chunks[0]!);
  await approveReview();
  const r = await pending;
  if (r.sw !== SW.OK) throw new Error(`SET_POLICY failed: 0x${r.sw.toString(16)}`);
}

type PayFields = {
  to: string; value: bigint; chainId?: bigint; token?: string;
  validAfter?: bigint; validBefore?: bigint; nonce?: string; hint?: string;
};

const VALID_BEFORE = 4_000_000_000n;

const buildPay = (f: PayFields) =>
  payPayload({
    chainId: f.chainId ?? ARC,
    token: f.token ?? TOKEN,
    to: f.to,
    value: f.value,
    validAfter: f.validAfter ?? 0n,
    validBefore: f.validBefore ?? VALID_BEFORE,
    nonce: f.nonce ?? `0x${'11'.repeat(32)}`,
    hint: f.hint,
  });

const pay = (f: PayFields) => {
  const data = buildPay(f);
  return apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, data.length, ...data]));
};

/** Recovers the signer from the device's signature and the typed data it should have signed. */
async function recoverSigner(f: PayFields, sig: Uint8Array) {
  expect(sig, 'a signature is v(1) | r(32) | s(32)').toHaveLength(65);
  const v = sig[0]!;
  expect([27, 28]).toContain(v);
  const signature = `0x${hex(sig.subarray(1, 33))}${hex(sig.subarray(33, 65))}${v.toString(16)}` as `0x${string}`;
  return recoverTypedDataAddress({
    domain: paymentDomain(Number(f.chainId ?? ARC), (f.token ?? TOKEN) as `0x${string}`),
    types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: process.env.SPECULOS_AGENT_ADDRESS as `0x${string}`,
      to: f.to as `0x${string}`,
      value: f.value,
      validAfter: f.validAfter ?? 0n,
      validBefore: f.validBefore ?? VALID_BEFORE,
      nonce: (f.nonce ?? `0x${'11'.repeat(32)}`) as `0x${string}`,
    },
    signature,
  });
}

const agent = () => (process.env.SPECULOS_AGENT_ADDRESS ?? '').toLowerCase();

describe('PAY: inside the rules, no button press', () => {
  beforeAll(async () => {
    await installPolicy();
    await setSession(true);
  });

  beforeEach(async () => {
    // Each test starts from a known budget.
    await dismissAnyModal();
    await installPolicy();
    await setSession(true);
  });

  it('signs a 3 USDC coffee silently, and the signature really authorises that payment', async () => {
    const f = { to: CAFE, value: 3n * USDC, hint: 'Cafe Sat' };
    const r = await pay(f);
    expect(r.sw, 'an in-policy payment must be signed').toBe(SW.OK);
    const signer = await recoverSigner(f, r.data);
    expect(signer.toLowerCase()).toBe(agent());
  });

  it('needs no interaction at all: four payments back to back', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await pay({ to: CAFE, value: 1n * USDC, nonce: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` });
      expect(r.sw, `payment ${i}`).toBe(SW.OK);
    }
    // No blocking screen appeared, or the second APDU would have come back 0x6901.
    const s = await state();
    expect(s.spent).toBe(4n * USDC);
    expect(s.count).toBe(4);
  });

  it('updates the budget and the last payment, which the home screen mirrors', async () => {
    await pay({ to: CAVE, value: 4n * USDC + 500_000n, hint: 'Cave du Coin' });
    const s = await state();
    expect(s.spent).toBe(4_500_000n);
    expect(s.count).toBe(1);
    expect(s.lastPayment).toEqual({ label: 'Cave du Coin', value: 4_500_000n });
    await screenshot('04-home-after-payment');
  });

  it('persists the counters before returning the signature', async () => {
    // Invariant 4. If the signature came back, the write already happened: there is no
    // ordering in which the host holds a signature the device has not accounted for.
    const r = await pay({ to: CAFE, value: 2n * USDC });
    expect(r.sw).toBe(SW.OK);
    expect((await state()).spent).toBe(2n * USDC);
  });

  it('signs exactly at the auto_max boundary', async () => {
    expect((await pay({ to: CAFE, value: 5n * USDC })).sw).toBe(SW.OK);
  });
});

describe('PAY: refused outright, a tap cannot override it', () => {
  beforeEach(async () => {
    await dismissAnyModal();
    await installPolicy();
    await setSession(true);
  });

  it('refuses with NO_SESSION when the agent is not armed', async () => {
    await setSession(false);
    const r = await pay({ to: CAFE, value: 1n * USDC });
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.NO_SESSION);
    await setSession(true);
  });

  it('refuses the wrong chain', async () => {
    const r = await pay({ to: CAFE, value: 1n * USDC, chainId: 1n });
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.WRONG_CHAIN_OR_TOKEN);
  });

  it('refuses the wrong token', async () => {
    const r = await pay({ to: CAFE, value: 1n * USDC, token: `0x${'99'.repeat(20)}` });
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.WRONG_CHAIN_OR_TOKEN);
  });

  it('refuses a zero amount', async () => {
    const r = await pay({ to: CAFE, value: 0n });
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.INVALID_AMOUNT);
  });

  it('refuses the evil 400 USDC deposit with OVER_HARD_MAX, never UNKNOWN_PAYEE', async () => {
    // The prompt-injection scenario. The payee is unknown AND the amount is absurd; the
    // device must report the hard ceiling, so no "trust this merchant" is ever offered.
    const r = await pay({ to: STRANGER, value: 400n * USDC, hint: 'Depot obligatoire' });
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.OVER_HARD_MAX);
    // And nothing was spent.
    expect((await state()).spent).toBe(0n);
  });

  it('refuses a value that does not fit a u64 rather than truncating it', async () => {
    const data = buildPay({ to: CAFE, value: 0n });
    data.fill(0xff, 48, 80); // the 32-byte value word
    const r = await apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, data.length, ...data]));
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.OVER_HARD_MAX);
  });

  it('refuses everything once the policy is cleared', async () => {
    const pending = apdu(Uint8Array.from([0xe0, INS.CLEAR_POLICY, 0, 0, 0]));
    await approveReview();
    expect((await pending).sw).toBe(SW.OK);

    const r = await pay({ to: CAFE, value: 1n * USDC });
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.NO_POLICY);
  });

  it('rejects a payload of the wrong length', async () => {
    const short = new Uint8Array(100);
    expect((await apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, short.length, ...short]))).sw).toBe(0x6700);
    const hintTooLong = new Uint8Array(176 + 25);
    expect((await apdu(Uint8Array.from([0xe0, INS.PAY, 0, 0, hintTooLong.length, ...hintTooLong]))).sw).toBe(0x6700);
  });
});

describe('PAY: the orange screen', () => {
  beforeEach(async () => {
    await dismissAnyModal();
    await installPolicy();
    await setSession(true);
  });

  it('shows the amount, the full address and the agent hint as unverified', async () => {
    const f = { to: STRANGER, value: 2n * USDC, hint: 'Bar du coin' };
    const pending = pay(f);
    await waitForText(/Payer/i);
    const shown = await flat();
    await screenshot('05-orange-unknown-payee');

    expect(shown, 'token and chain on every screen').toMatch(/2 USDC sur Arc/);
    expect(shown).toMatch(/Marchand\s+inconnu/i);
    expect(shown.replace(/\s/g, ''), 'the FULL address must be shown').toContain(STRANGER.slice(2));
    expect(shown, 'the agent claim and its caveat must stay on one line').toMatch(/"Bar du coin"\s*non verifie/i);
    
    expect(shown).toMatch(/Refuser/);
    expect(shown).toMatch(/Une fois/);
    expect(shown).toMatch(/Faire confiance/);

    await tapText('Refuser');
    const r = await pending;
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.USER_REJECTED);
    expect((await state()).spent, 'a refusal must not spend').toBe(0n);
  });

  it('"Une fois" signs this payment and never adds the payee', async () => {
    const f = { to: STRANGER, value: 2n * USDC, hint: 'Bar du coin' };
    const pending = pay(f);
    await waitForText(/Payer/i);
    await tapText('Une fois');
    const r = await pending;
    expect(r.sw).toBe(SW.OK);
    expect((await recoverSigner(f, r.data)).toLowerCase()).toBe(agent());

    const s = await state();
    expect(s.spent).toBe(2n * USDC);
    expect(s.policy.payees.map((p) => p.address), '"Une fois" must never add a payee')
      .toEqual([CAFE, CAVE, RESTO]);

    // Proof it was one-shot: the same payee needs the orange screen again.
    const second = pay({ ...f, nonce: `0x${'22'.repeat(32)}` });
    await waitForText(/Payer/i);
    await tapText('Refuser');
    expect((await second).sw).toBe(SW.DENY);
  });

  it('"Faire confiance" signs and adds the payee with the hint as its label', async () => {
    const f = { to: STRANGER, value: 2n * USDC, hint: 'Bar du coin' };
    const pending = pay(f);
    await waitForText(/Payer/i);
    await tapText('Faire confiance');
    expect((await pending).sw).toBe(SW.OK);

    const s = await state();
    expect(s.policy.payees).toHaveLength(4);
    expect(s.policy.payees[3]).toEqual({ address: STRANGER, label: 'Bar du coin' });

    // Now the same merchant is silent, which is the whole point of trusting it.
    const again = await pay({ ...f, nonce: `0x${'33'.repeat(32)}` });
    expect(again.sw, 'a trusted payee must now be automatic').toBe(SW.OK);
  });

  it('does not offer "Faire confiance" when the amount is the problem', async () => {
    // The restaurant: 20 USDC to a KNOWN payee, over auto_max. Trusting it would change
    // nothing, so the option must be absent.
    const pending = pay({ to: RESTO, value: 20n * USDC, hint: 'Resto' });
    await waitForText(/Payer/i);
    const shown = await flat();
    await screenshot('06-orange-over-auto-max');
    expect(shown).toMatch(/20 USDC sur Arc/);
    expect(shown).toMatch(/Hors limite\s+auto/i);
    expect(shown).toMatch(/Une fois/);
    expect(shown, 'trusting cannot help here').not.toMatch(/Faire confiance/);

    await tapText('Une fois');
    expect((await pending).sw).toBe(SW.OK);
    expect((await state()).spent).toBe(20n * USDC);
  });

  it('salami slicing: four 4.99 payments are silent, the fifth hits the budget', async () => {
    const slice = 4n * USDC + 990_000n;
    for (let i = 0; i < 4; i++) {
      const r = await pay({ to: CAFE, value: slice, nonce: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` });
      expect(r.sw, `slice ${i} must be silent`).toBe(SW.OK);
    }
    expect((await state()).spent).toBe(19n * USDC + 960_000n);

    const pending = pay({ to: CAFE, value: slice, nonce: `0x${'ff'.repeat(32)}` });
    await waitForText(/Payer/i);
    const shown = await flat();
    expect(shown).toMatch(/Budget\s+depasse/i);
    await screenshot('07-orange-budget-exceeded');
    await tapText('Refuser');
    expect((await pending).sw).toBe(SW.DENY);
  });
});
