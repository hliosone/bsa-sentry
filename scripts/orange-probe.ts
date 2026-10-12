// Hardware diagnosis for the orange screen: which on-screen tap does the Flex report?
//   pnpm exec tsx scripts/orange-probe.ts      (BSA Sentry open on the Flex, over USB)
import 'dotenv/config';
import { DeviceRefusedError, SentrySigner } from '@bsa-sentry/sentry-signer';
import { NodeHidTransport } from '@bsa-sentry/sentry-signer/transports/node-hid';

const USDC = 1_000_000n, ARC = 5042002n, TOKEN = '0x3600000000000000000000000000000000000000' as const;
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;
const RESTO = '0xd4e15888844c2df59cf371917c11a99267917af5' as const;
const STRANGER = ('0x' + '6b'.repeat(20)) as `0x${string}`;
let n = Math.floor(Date.now() / 1000) % 200;
const pay = (to: `0x${string}`, value: bigint) => ({
  chainId: ARC, token: TOKEN, to, value, validAfter: 0n, validBefore: 4_000_000_000n,
  nonce: `0x${(++n).toString(16).padStart(2, '0').repeat(32)}` as `0x${string}`,
});
const say = (s: string) => console.log(`\n  \x1b[33m>> ON THE FLEX: ${s}\x1b[0m`);
const t = process.env.PROBE_TRANSPORT === 'speculos'
  ? new (await import('@bsa-sentry/sentry-signer/transports/speculos')).SpeculosTransport()
  : await NodeHidTransport.open();
const s = new SentrySigner(t);

async function outcome(p: Promise<unknown>) {
  const t0 = Date.now();
  const r = await p.then(() => 'SIGNED', (e) => (e instanceof DeviceRefusedError ? `refused ${e.reason}` : `error ${(e as Error).message}`));
  return `${r} after ${((Date.now() - t0) / 1000).toFixed(1)} s`;
}

console.log('\nOrange-screen probe (real Flex)');
say('swipe through the rules, then hold to approve (this resets the budget)');
await s.setPolicy({ active: true, chainId: ARC, token: TOKEN, autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [{ address: CAFE, label: 'Cafe Sat' }, { address: RESTO, label: 'Resto' }] });
if (!(await s.getState()).sessionArmed) {
  say('tap the gear, turn on "Agent session", tap the back arrow');
  for (let i = 0; i < 90 && !(await s.getState()).sessionArmed; i++) await new Promise((r) => setTimeout(r, 1000));
}

const results: string[] = [];
say('A — tap ONCE on the ADDRESS text in the middle (NOT a button), then touch nothing (auto-refusal at 60 s)');
results.push(`A middle tap   (expect: refused TIMEOUT ~60 s): ${await outcome(s.pay(pay(RESTO, 20n * USDC), { hint: 'Resto' }))}`);
console.log('  ' + results.at(-1));
say('B — tap "Refuser" (top right)');
results.push(`B Refuser      (expect: refused USER_REJECTED):  ${await outcome(s.pay(pay(RESTO, 20n * USDC), { hint: 'Resto' }))}`);
console.log('  ' + results.at(-1));
say('C — tap "Faire confiance" (black button)');
results.push(`C Faire conf.  (expect: SIGNED, merchant added):  ${await outcome(s.pay(pay(STRANGER, 1n * USDC), { hint: 'Kiosque' }))}`);
const st = await s.getState();
results.push(`  merchant added: ${st.policy.payees.some((p) => p.address === STRANGER)}`);
console.log('  ' + results.slice(-2).join('\n  '));
const left = (Number(st.policy.budget - st.spent) / 1e6).toFixed(2);
console.log(`\nSummary\n  ${results.join('\n  ')}\n\n  The home screen should now read: Budget ${left} / 20.00 USDC`);
await (t as { close?: () => Promise<void> }).close?.();
process.exit(0);
