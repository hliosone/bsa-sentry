// Prints the USDC (6 dp) balance of every address in .env. Read-only.
import 'dotenv/config';
import { createPublicClient, http, formatUnits } from 'viem';
import { arcTestnet, USDC_ADDRESS, ERC20_ABI } from './chain.js';

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const roles = [
  ['treasury', process.env.TREASURY_ADDRESS],
  ['facilitator', process.env.FACILITATOR_ADDRESS],
  ['speculos 0xAGENT', process.env.SPECULOS_AGENT_ADDRESS],
  ['speculos 0xMAIN', process.env.SPECULOS_MAIN_ADDRESS],
  ['merchant cafe', process.env.MERCHANT_CAFE_ADDRESS],
  ['merchant cave', process.env.MERCHANT_CAVE_ADDRESS],
  ['merchant resto', process.env.MERCHANT_RESTO_ADDRESS],
  ['merchant evil', process.env.MERCHANT_EVIL_ADDRESS],
  ...process.argv.slice(2).map((a, i) => [`argv[${i}]`, a] as const),
].filter(([, a]) => !!a) as [string, `0x${string}`][];

console.log(`Arc testnet (chainId ${await client.getChainId()}) USDC ${USDC_ADDRESS}\n`);
for (const [label, address] of roles) {
  const bal = await client.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
  console.log(`  ${label.padEnd(18)} ${formatUnits(bal, 6).padStart(12)} USDC   ${address}`);
}
