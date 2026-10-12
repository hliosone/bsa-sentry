// Hardware diagnosis of the confirmation screen, with the DIAG build only
// (FEATURES=diag scripts/device-build.sh && make load). Never use the diag build for anything
// else: its INS 0x7E can arm the session without the device. Reinstall the normal build after.
//
//   pnpm exec tsx scripts/orange-diag.ts
//
// Three trials, one button each (Reject, Pay once, Trust merchant), each to a new unknown
// merchant, printing what the Flex itself recorded for every tap.
import 'dotenv/config';
import { DeviceRefusedError, SentrySigner } from '@bsa-sentry/sentry-signer';
import { NodeHidTransport } from '@bsa-sentry/sentry-signer/transports/node-hid';

const USDC = 1_000_000n, ARC = 5042002n, TOKEN = '0x3600000000000000000000000000000000000000' as const;
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;
let n = Math.floor(Date.now() / 1000) % 200;
// A different unknown merchant for every trial: once one is trusted, later payments to it are
// inside the rules and sign silently, which would hide the screen we want to test.
const pay = (to: `0x${string}`) => ({
  chainId: ARC, token: TOKEN, to, value: USDC,
  validAfter: 0n, validBefore: 4_000_000_000n, nonce: `0x${(++n).toString(16).padStart(2, '0').repeat(32)}` as `0x${string}`,
});
const say = (s: string) => console.log(`\n  \x1b[33m>> ON THE FLEX: ${s}\x1b[0m`);
const t = process.env.PROBE_TRANSPORT === 'speculos'
  ? new (await import('@bsa-sentry/sentry-signer/transports/speculos')).SpeculosTransport()
  : await NodeHidTransport.open();
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
    out.push(tok === 2 ? 'Reject' : tok === 1 ? (idx === 0 ? 'Trust merchant' : 'Pay once') : `token ${tok}/${idx}`);
  }
  return out.length ? out.join(', ') : 'no tap reported';
};

const rows: string[] = [];
async function trial(button: 'Reject' | 'Pay once' | 'Trust merchant', where: string, to: `0x${string}`) {
  await diag(1, 0); // the shipped layout; also clears the tap log
  say(`the Flex shows "Pay 1 USDC on Arc?". Tap ONLY "${button}" (${where}).`);
  const r = await s.pay(pay(to), { hint: 'Test shop' }).then(() => 'signed', (e) => (e instanceof DeviceRefusedError ? `refused (${e.reason})` : `error ${(e as Error).message}`));
  const trusted = (await s.getState()).policy.payees.some((p) => p.address === to);
  const expected = button === 'Reject' ? r.startsWith('refused') && !trusted
    : button === 'Pay once' ? r === 'signed' && !trusted : r === 'signed' && trusted;
  rows.push(`${expected ? 'OK   ' : 'WRONG'} asked "${button}": ${r}${trusted ? ', merchant trusted' : ''} | the Flex saw: ${showLog(await diag(0))}`);
  console.log('  ' + rows.at(-1));
}

console.log('\nConfirmation-screen check (diag build). Nothing is sent to the blockchain.');
say('swipe through the rules, then hold to approve');
await s.setPolicy({ active: true, chainId: ARC, token: TOKEN, autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
  payees: [{ address: CAFE, label: 'Cafe Sat' }] });
await diag(2, 1); // arm the session from the computer (diag build only)

await trial('Reject', 'the word at the TOP RIGHT, not a button', ('0x' + '71'.repeat(20)) as `0x${string}`);
await trial('Pay once', 'the WHITE button at the bottom', ('0x' + '72'.repeat(20)) as `0x${string}`);
await trial('Trust merchant', 'the BLACK button', ('0x' + '73'.repeat(20)) as `0x${string}`);

console.log(`\nResult\n  ${rows.join('\n  ')}\n`);
await (t as { close?: () => Promise<void> }).close?.();
process.exit(0);
