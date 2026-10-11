// Sends USDC from the treasury to any address.  pnpm fund <address> [amount=5]
import 'dotenv/config';
import { formatUnits, isAddress, type Hex } from 'viem';
import { transferUsdc, balanceOf, usdc } from './transfer.js';

const [to, amount = '5'] = process.argv.slice(2);
if (!to || !isAddress(to)) {
  console.error('usage: pnpm fund <0xaddress> [amount in USDC, default 5]');
  process.exit(1);
}
const key = process.env.TREASURY_PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error('TREASURY_PRIVATE_KEY missing from .env');

const value = usdc(amount);
const before = await balanceOf(to as Hex);
await transferUsdc(key, to as Hex, value);
const after = await balanceOf(to as Hex);
console.log(`  recipient ${formatUnits(before, 6)} -> ${formatUnits(after, 6)} USDC`);
