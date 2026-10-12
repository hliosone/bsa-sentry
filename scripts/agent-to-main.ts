// Sends USDC from the agent wallet back to the main account, signed on the Flex.
//
//   pnpm exec tsx scripts/agent-to-main.ts 35
//
// The agent key never leaves the Flex: this asks it for an ordinary PAY to 0xMAIN. The main
// account is not a trusted merchant, so the Flex shows the confirmation screen and only offers
// "Pay once". The signed authorization is then submitted by the facilitator key, which pays the
// gas. Close the website tab first (one program at a time on the Flex), keep BSA Sentry open
// and the agent session on.
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DeviceRefusedError, SentrySigner } from '@bsa-sentry/sentry-signer';
import { NodeHidTransport } from '@bsa-sentry/sentry-signer/transports/node-hid';
import { arcTestnet, ARC_EXPLORER, MIN_MAX_FEE_PER_GAS, USDC_ADDRESS } from './chain.js';
import { USDC_ABI } from '../apps/server/src/chain.js';

const amount = BigInt(Math.round(Number(process.argv[2] ?? '35') * 1e6));
const t = await NodeHidTransport.open();
const s = new SentrySigner(t);
const [main, agent] = [await s.getAddress('main'), await s.getAddress('agent')];
const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Hex;
const f = { chainId: 5042002n, token: USDC_ADDRESS as Hex, to: main, value: amount, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce };

console.log(`\n  ${Number(amount) / 1e6} USDC from the agent wallet ${agent}\n  to your main account ${main}`);
console.log('\n  \x1b[33m>> ON THE FLEX: check the amount and the full address (your main account), then tap "Pay once"\x1b[0m');
let sig;
try {
  sig = await s.pay(f, { hint: 'Back to main account' });
} catch (e) {
  console.log(`\n  not signed: ${e instanceof DeviceRefusedError ? e.reason : (e as Error).message}`);
  process.exit(1);
}
await t.close();

const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
const wallet = createWalletClient({ chain: arcTestnet, transport: http(), account: privateKeyToAccount(process.env.FACILITATOR_PRIVATE_KEY as Hex) });
const fees = await publicClient.estimateFeesPerGas();
const maxFeePerGas = (fees.maxFeePerGas ?? 0n) > MIN_MAX_FEE_PER_GAS ? fees.maxFeePerGas! : MIN_MAX_FEE_PER_GAS;
const hash = await wallet.writeContract({
  address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'transferWithAuthorization',
  args: [agent, main, f.value, f.validAfter, f.validBefore, f.nonce, sig.v, sig.r, sig.s],
  maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas,
} as any);
const r = await publicClient.waitForTransactionReceipt({ hash });
console.log(`\n  ${r.status === 'success' ? 'done' : 'FAILED'}: ${ARC_EXPLORER}/tx/${hash}\n`);
process.exit(r.status === 'success' ? 0 : 1);
