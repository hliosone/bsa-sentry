// Sweeps the merchants' payTo balances back to the treasury, so e2e tests never run out of funds.
// On Arc gas is paid in USDC, so each merchant pays its own gas; GAS_RESERVE is left behind for it.
import 'dotenv/config';
import { formatUnits, type Hex } from 'viem';
import { transferUsdc, balanceOf, usdc } from './transfer.js';

/** Left on each merchant so it can pay the gas of this very transfer (~0.002 USDC measured). */
const GAS_RESERVE = usdc('0.05');
/** Below this, sweeping costs more than it recovers. */
const MIN_SWEEP = usdc('0.1');

const treasury = process.env.TREASURY_ADDRESS as Hex;
if (!treasury) throw new Error('TREASURY_ADDRESS missing from .env');

const merchants = (['CAFE', 'CAVE', 'RESTO', 'EVIL'] as const)
  .map((m) => ({ name: m.toLowerCase(), key: process.env[`MERCHANT_${m}_PRIVATE_KEY`] as Hex, address: process.env[`MERCHANT_${m}_ADDRESS`] as Hex }))
  .filter((m) => m.key && m.address);

let recovered = 0n;
for (const m of merchants) {
  const bal = await balanceOf(m.address);
  if (bal <= GAS_RESERVE + MIN_SWEEP) {
    console.log(`  ${m.name.padEnd(6)} ${formatUnits(bal, 6).padStart(10)} USDC  skipped (nothing worth sweeping)`);
    continue;
  }
  const value = bal - GAS_RESERVE;
  await transferUsdc(m.key, treasury, value);
  recovered += value;
}
console.log(`\n  recovered ${formatUnits(recovered, 6)} USDC -> treasury (now ${formatUnits(await balanceOf(treasury), 6)} USDC)`);
