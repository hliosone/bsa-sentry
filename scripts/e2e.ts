// M8 acceptance: the full demo twice in a row, each from a clean reset.
//
// Reset = a wiped Flex (fresh Speculos NVM, same seed), the merchants' takings swept back to
// the treasury, and the agent topped up so the run can pay for everything it buys.
//
//   E2E=1 pnpm e2e
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import type { Hex } from 'viem';
import { balanceOf, transferUsdc, usdc } from './transfer.js';
import * as ui from './speculos-ui.js';
import { runDemo } from './demo.js';

if (process.env.E2E !== '1') {
  console.log('pnpm e2e spends real testnet USDC on Arc; run it with E2E=1');
  process.exit(0);
}

/** One demo run buys 3 + 2 + 4.5 + 20 = 29.5 USDC. */
const NEEDED = usdc('29.5');

async function reset(run: number) {
  console.log(`\n\x1b[1m── reset before run ${run} ──\x1b[0m`);
  execFileSync('pnpm', ['-s', 'recycle'], { stdio: 'inherit' });
  const agent = process.env.SPECULOS_AGENT_ADDRESS as Hex;
  const have = await balanceOf(agent);
  if (have < NEEDED) await transferUsdc(process.env.TREASURY_PRIVATE_KEY as Hex, agent, NEEDED - have + usdc('0.5'));
  ui.restart(true);
  console.log('  Flex wiped (fresh NVM, same seed); agent funded');
}

let failures = 0;
for (const run of [1, 2]) {
  await reset(run);
  failures += await runDemo(`demo run ${run} of 2`);
}
execFileSync('pnpm', ['-s', 'recycle'], { stdio: 'inherit' });
console.log(failures === 0 ? '\n\x1b[32mM8: the full demo passed twice in a row\x1b[0m' : `\n\x1b[31m${failures} failure(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
