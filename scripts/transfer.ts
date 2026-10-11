// Shared USDC transfer helper for the dev scripts (fund / recycle).
// On Arc, gas is paid in USDC, so any funded address can pay its own gas.
import { createPublicClient, createWalletClient, http, formatUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, USDC_ADDRESS, ERC20_ABI, MIN_MAX_FEE_PER_GAS, ARC_EXPLORER } from './chain.js';

export const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });

export const usdc = (human: string | number): bigint => {
  const [int, frac = ''] = String(human).split('.');
  if (frac.length > 6) throw new Error(`USDC has 6 decimals, got "${human}"`);
  return BigInt(int + frac.padEnd(6, '0'));
};

export const balanceOf = (address: Hex) =>
  publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });

/** maxFeePerGas is floored: Arc silently drops anything under 20 gwei. */
export const feeFloor = (suggested: bigint) => (suggested > MIN_MAX_FEE_PER_GAS ? suggested : MIN_MAX_FEE_PER_GAS);

/** Sends `value` USDC base units from `privateKey` to `to`. Waits for the receipt. */
export async function transferUsdc(privateKey: Hex, to: Hex, value: bigint) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const fees = await publicClient.estimateFeesPerGas();
  const hash = await wallet.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'transfer', args: [to, value],
    maxFeePerGas: feeFloor(fees.maxFeePerGas),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ${account.address} -> ${to}  ${formatUnits(value, 6)} USDC  [${receipt.status}]  ${ARC_EXPLORER}/tx/${hash}`);
  if (receipt.status !== 'success') throw new Error(`transfer reverted: ${hash}`);
  return receipt;
}
