// Hardware diagnosis of the confirmation screen, with the DIAG build only
// (FEATURES=diag scripts/device-build.sh && make load). Never use the diag build for anything
// else: its INS 0x7E can arm the session without the device. Reinstall the normal build after.
//
//   pnpm exec tsx scripts/orange-diag.ts
//
// Four single taps on "Refuser". Varies (a) the screen layout and (b) whether the home-screen
// switch was touched first, and prints what NBGL reported for every tap.
import 'dotenv/config';
import { DeviceRefusedError, SentrySigner } from '@bsa-sentry/sentry-signer';
import { NodeHidTransport } from '@bsa-sentry/sentry-signer/transports/node-hid';

const USDC = 1_000_000n, ARC = 5042002n, TOKEN = '0x3600000000000000000000000000000000000000' as const;
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;
const RESTO = '0xd4e15888844c2df59cf371917c11a99267917af5' as const;
let n = Math.floor(Date.now() / 1000) % 200;
const pay = (value: bigint) => ({
  chainId: ARC, token: TOKEN, to: ('0x' + '7c'.repeat(20)) as `0x${string}`, value,
  validAfter: 0n, validBefore: 4_000_000_000n, nonce: `0x${(++n).toString(16).padStart(2, '0').repeat(32)}` as `0x${string}`,
});
const say = (s: string) => console.log(`\n  \x1b[33m>> ON THE FLEX: ${s}\x1b[0m`);
const t = await NodeHidTransport.open();
const s = new SentrySigner(t);
const diag = async (p1: number, p2 = 0) => {
  const r = await t.send(Uint8Array.from([0xe0, 0x7e, p1, p2, 0]));
  if (r[r.length - 2] !== 0x90) throw new Error('this is not the diag build: run FEATURES=diag scripts/device-build.sh && make load');
  return r.subarray(0, r.length - 2);
};
const showLog = (log: Uint8Array) => {
  const out: string[] = [];
  for (let i = 0; i < Math.min(log[0]!, 8); i++) {
    const [tok, idx] = [log[1 + 2 * i]!, log[2 + 2 * i]!];
    out.push(tok === 2 ? 'Refuser' : tok === 1 ? (idx === 0 ? 'Faire confiance' : 'Une fois') : `token ${tok}/${idx}`);
  }
  return out.length ? out.join(', ') : 'no tap reported';
};

const rows: string[] = [];
async function trial(label: string, variant: number) {
  await diag(1, variant);
  say(`${label}: tap "Refuser" (top right), once`);
  const r = await s.pay(pay(USDC), { hint: 'Kiosque' }).then(() => 'SIGNED  <-- wrong', (e) => (e instanceof DeviceRefusedError ? `refused ${e.reason}` : `error ${(e as Error).message}`));
  rows.push(`${label.padEnd(44)} ${r.padEnd(24)} NBGL saw: ${showLog(await diag(0))}`);
  console.log('  ' + rows.at(-1));
}

await diag(0);
console.log('\nConfirmation-screen diagnosis (diag build)');
say('swipe through the rules, then hold to approve');
await s.setPolicy({ active: true, chainId: ARC, token: TOKEN, autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [{ address: CAFE, label: 'Cafe Sat' }, { address: RESTO, label: 'Resto' }] });
await diag(2, 1); // armed without touching the home screen

await trial('1 current layout, home not touched', 0);
await trial('2 feasibility layout, home not touched', 1);

await diag(2, 0);
say('tap the gear, turn ON "Agent session", tap the back arrow');
for (let i = 0; i < 90 && !(await s.getState()).sessionArmed; i++) await new Promise((r) => setTimeout(r, 1000));
await trial('3 current layout, after the home switch', 0);
await trial('4 feasibility layout, after the home switch', 1);

console.log(`\nResult\n  ${rows.join('\n  ')}\n`);
await t.close();
process.exit(0);
