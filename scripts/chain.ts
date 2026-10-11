// Arc testnet constants, shared by the dev scripts. Proven in the feasibility tests.
import { defineChain } from 'viem';

export const ARC_CHAIN_ID = 5042002;
export const ARC_RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io';
export const ARC_EXPLORER = 'https://explorer.testnet.arc.io';
/** USDC on Arc: ERC-20 interface (6 decimals, EIP-3009) and the gas token. */
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;
/** The mempool silently drops transactions under this. */
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n;

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: ARC_EXPLORER } },
});

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;
