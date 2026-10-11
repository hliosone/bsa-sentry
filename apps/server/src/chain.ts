// Arc testnet, and the slice of the USDC ABI the server needs. Values come from the env so
// the same code can point at Base Sepolia (CHAIN=base) without edits.
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const USDC_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'authorizationState', stateMutability: 'view',
    inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'event', name: 'Transfer', anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

export type ChainConfig = { chainId: number; rpcUrl: string; usdc: Hex; explorer: string; name: string };

export function chainConfig(env = process.env): ChainConfig {
  if ((env.CHAIN ?? 'arc') === 'base') {
    return {
      chainId: 84532, name: 'Base Sepolia', rpcUrl: env.BASE_RPC_URL ?? 'https://sepolia.base.org',
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', explorer: 'https://sepolia.basescan.org',
    };
  }
  return {
    chainId: Number(env.CHAIN_ID ?? 5042002),
    name: 'Arc testnet',
    rpcUrl: env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.io',
    usdc: (env.USDC_ADDRESS ?? '0x3600000000000000000000000000000000000000') as Hex,
    explorer: env.ARC_EXPLORER ?? 'https://explorer.testnet.arc.io',
  };
}

export function clients(cfg: ChainConfig, privateKey?: Hex) {
  // Arc's native currency is USDC with 18 decimals; viem only uses it for gas display.
  const chain = defineChain({
    id: cfg.chainId, name: cfg.name,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const walletClient = privateKey
    ? createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport: http(cfg.rpcUrl) })
    : undefined;
  return { chain, publicClient, walletClient };
}
