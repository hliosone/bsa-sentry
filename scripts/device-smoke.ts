// End-to-end smoke test of the device, through sentry-signer.
//
//   pnpm smoke                 against Speculos, taps simulated (CI, Phase B)
//   SMOKE_TRANSPORT=hid pnpm smoke   against a real Flex, you tap (Phase C)
//
// Same assertions either way: the only difference is the transport and who presses.
// Covers the four behaviours the product is about: an automatic payment, the confirmation screen
// with each of its three answers, the 60 s auto-refusal, and an outright refusal.
import 'dotenv/config';
import { recoverTypedDataAddress } from 'viem';
import {
  EIP712_TYPES, paymentDomain, toViemSignature, type Policy,
} from '@bsa-sentry/types';
import { DeviceRefusedError, SentrySigner, type Transport } from '@bsa-sentry/sentry-signer';
import { SpeculosTransport } from '@bsa-sentry/sentry-signer/transports/speculos';
import * as ui from './speculos-ui.js';

const ARC = 5042002n;
const USDC = 1_000_000n;
const TOKEN = (process.env.USDC_ADDRESS ?? '0x3600000000000000000000000000000000000000') as `0x${string}`;
const CAFE = (process.env.MERCHANT_CAFE_ADDRESS ?? '').toLowerCase() as `0x${string}`;
const RESTO = (process.env.MERCHANT_RESTO_ADDRESS ?? '').toLowerCase() as `0x${string}`;
const EVIL = (process.env.MERCHANT_EVIL_ADDRESS ?? '').toLowerCase() as `0x${string}`;

const onSpeculos = (process.env.SMOKE_TRANSPORT ?? 'speculos') !== 'hid';
/** On hardware the human taps; skip the slow timeout case unless explicitly asked. */
const runTimeout = process.env.SMOKE_TIMEOUT === '1' || onSpeculos;

let failures = 0;
const pass = (what: string) => console.log(`  \x1b[32mPASS\x1b[0m  ${what}`);
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function check(what: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass(what);
  } catch (e) {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${what}\n        ${err(e)}`);
  }
}

/** On hardware we print what to do and wait; on Speculos we tap for the user. */
async function act(instruction: string, simulated: () => Promise<void>) {
  if (onSpeculos) {
    await simulated();
    return;
  }
  console.log(`\n  \x1b[33m>> ON THE FLEX: ${instruction}\x1b[0m`);
  // Nothing to do: the signer call is already waiting on the device.
}

/**
 * Starts a device call, performs the on-screen answer, and returns the outcome.
 *
 * The `.catch` is attached immediately: if the tap step throws (a button is not where we
 * expect), the in-flight call would otherwise reject with nobody listening, and an
 * unhandled rejection takes the whole script down instead of failing one check.
 */
async function answering<T>(call: Promise<T>, instruction: string, tap: () => Promise<void>): Promise<T | Error> {
  const settled = call.catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  try {
    await act(instruction, tap);
  } catch (e) {
    await settled; // let the device finish before reporting the tap failure
    throw e;
  }
  return settled;
}

const demoPolicy = (): Policy => ({
  active: true, chainId: ARC, token: TOKEN,
  autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [{ address: CAFE, label: 'Cafe Sat' }, { address: RESTO, label: 'Restaurant' }],
});

let nonceCounter = 0;
const payment = (to: `0x${string}`, value: bigint) => ({
  chainId: ARC, token: TOKEN, to, value,
  validAfter: 0n, validBefore: 4_000_000_000n,
  nonce: `0x${(++nonceCounter).toString(16).padStart(2, '0').repeat(32)}` as `0x${string}`,
});

async function openTransport(): Promise<{ transport: Transport; close: () => Promise<void> }> {
  if (onSpeculos) return { transport: new SpeculosTransport(), close: async () => {} };
  const { NodeHidTransport } = await import('@bsa-sentry/sentry-signer/transports/node-hid');
  const t = await NodeHidTransport.open();
  return { transport: t, close: () => t.close() };
}

async function main() {
  console.log(`\nBSA Sentry device smoke test  (transport: ${onSpeculos ? 'speculos' : 'real Flex over USB HID'})\n`);
  const { transport, close } = await openTransport();
  const signer = new SentrySigner(transport);

  const agent = await signer.getAddress('agent');
  const main = await signer.getAddress('main');
  console.log(`  0xAGENT ${agent}\n  0xMAIN  ${main}\n`);
  if (agent === main) throw new Error('0xMAIN and 0xAGENT must differ');

  // ---------------------------------------------------------------- setup
  console.log('Setup');
  await check('SET_POLICY stores the demo rules after a review', async () => {
    const pending = signer.setPolicy(demoPolicy());
    await act('swipe through the rules, then hold to approve', ui.approveReview);
    await pending;
    const state = await signer.getState();
    if (!state.policy.active) throw new Error('the policy is not active');
    if (state.spent !== 0n) throw new Error('SET_POLICY must reset the counters');
  });

  await check('the agent session is armed from the device', async () => {
    await act('tap the gear (top right), turn on "Agent session", then tap the back arrow', () =>
      ui.setSessionVia(async () => (await signer.getState()).sessionArmed, true));
    // No device call is pending for a switch, so on hardware wait for the user to flip it.
    for (let i = 0; i < 60 && !(await signer.getState()).sessionArmed; i++) await new Promise((r) => setTimeout(r, 1000));
    if (!(await signer.getState()).sessionArmed) throw new Error('the session is not armed (waited 60 s)');
  });

  // ---------------------------------------------------------------- the four behaviours
  console.log('\nInside the rules');
  await check('a 3 USDC coffee is signed with no button press', async () => {
    const f = payment(CAFE, 3n * USDC);
    const sig = await signer.pay(f, { hint: 'Cafe Sat' });
    const signer_ = await recoverTypedDataAddress({
      domain: paymentDomain(Number(ARC), TOKEN),
      types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization',
      message: { from: agent, to: f.to, value: f.value, validAfter: f.validAfter, validBefore: f.validBefore, nonce: f.nonce },
      signature: toViemSignature(`0x${sig.v.toString(16)}${sig.r.slice(2)}${sig.s.slice(2)}`),
    });
    if (signer_.toLowerCase() !== agent) throw new Error(`signed by ${signer_}, expected ${agent}`);
    if ((await signer.getState()).spent !== 3n * USDC) throw new Error('the budget did not move');
  });

  console.log('\nOutside the rules: the confirmation screen');
  await check('"Reject" refuses and spends nothing', async () => {
    const before = (await signer.getState()).spent;
    const e = await answering(
      signer.pay(payment(RESTO, 20n * USDC), { hint: 'Restaurant' }),
      'tap "Reject"',
      async () => { await ui.waitForText(/on Arc\?/i); await ui.tapText('Reject'); },
    );
    if (!(e instanceof DeviceRefusedError) || e.reason !== 'USER_REJECTED') throw new Error(`got ${err(e)}`);
    if ((await signer.getState()).spent !== before) throw new Error('a refusal must not spend');
  });

  // Trusting a merchant comes first: "Trust merchant" is only offered when the unknown
  // payee is the ONLY problem, so it has to run while there is still budget left.
  await check('"Trust merchant" adds the merchant, which then pays silently', async () => {
    const stranger = ('0x' + '5a'.repeat(20)) as `0x${string}`;
    const out = await answering(
      signer.pay(payment(stranger, 1n * USDC), { hint: 'Kiosk' }),
      'tap "Trust merchant"',
      async () => { await ui.waitForText(/on Arc\?/i); await ui.tapText('Trust merchant'); },
    );
    if (out instanceof Error) throw out;
    const added = (await signer.getState()).policy.payees.find((p) => p.address === stranger);
    if (!added) throw new Error('the payee was not added');
    if (added.label !== 'Kiosk') throw new Error(`label is ${added.label}`);
    await signer.pay(payment(stranger, 1n * USDC)); // trusted now: must not prompt
  });

  await check('"Pay once" signs once and adds no payee', async () => {
    const before = (await signer.getState()).policy.payees.length;
    const out = await answering(
      signer.pay(payment(RESTO, 20n * USDC), { hint: 'Restaurant' }),
      'tap "Pay once"',
      async () => { await ui.waitForText(/on Arc\?/i); await ui.tapText('Pay once'); },
    );
    if (out instanceof Error) throw out;
    if ((await signer.getState()).policy.payees.length !== before) throw new Error('"Pay once" added a payee');
  });

  console.log('\nRefused outright');
  await check('400 USDC to an unknown address is OVER_HARD_MAX, with no screen', async () => {
    const e = await signer.pay(payment(EVIL, 400n * USDC), { hint: 'Mandatory deposit' }).catch((x) => x);
    if (!(e instanceof DeviceRefusedError) || e.reason !== 'OVER_HARD_MAX') throw new Error(`got ${err(e)}`);
  });

  if (runTimeout) {
    console.log('\nThe 60 s auto-refusal (this one really waits)');
    await check('touching nothing refuses after ~60 s and spends nothing', async () => {
      const before = (await signer.getState()).spent;
      const started = Date.now();
      const e = await answering(
        signer.pay(payment(RESTO, 20n * USDC), { hint: 'Patience' }),
        'do not touch the device for 60 seconds',
        async () => { await ui.waitForText(/on Arc\?/i); },
      );
      const elapsed = (Date.now() - started) / 1000;
      if (!(e instanceof DeviceRefusedError)) throw new Error(`got ${err(e)}`);
      if (elapsed < 55) throw new Error(`refused after only ${elapsed}s`);
      if ((await signer.getState()).spent !== before) throw new Error('a timeout must not spend');
      console.log(`        (refused after ${elapsed.toFixed(1)}s)`);
    });
  } else {
    console.log('\n  (skipping the 60 s timeout; set SMOKE_TIMEOUT=1 to include it)');
  }

  await close();
  const state = await (async () => { try { return await signer.getState(); } catch { return null; } })();
  if (state) console.log(`\nBudget now ${Number(state.spent) / 1e6} / ${Number(state.policy.budget) / 1e6} USDC, ${state.count} payments`);
  console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nsmoke test could not run:', err(e));
  process.exit(2);
});
