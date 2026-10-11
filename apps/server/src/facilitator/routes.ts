// HTTP face of the facilitator, plus the real chain wiring for it.
import { Router, json } from 'express';
import type { Hex } from 'viem';
import { USDC_ABI, clients, type ChainConfig } from '../chain.js';
import { settlePayment, verifyPayment, type SettleDeps } from './facilitator.js';

/** Real viem-backed dependencies. The facilitator key only ever pays gas and submits. */
export function chainDeps(cfg: ChainConfig, facilitatorKey: Hex, extra: Partial<SettleDeps> = {}): SettleDeps & { address: Hex } {
  const { publicClient, walletClient } = clients(cfg, facilitatorKey);
  if (!walletClient) throw new Error('facilitator key required');
  return {
    address: walletClient.account.address,
    chainId: cfg.chainId,
    usdc: cfg.usdc,
    now: () => Math.floor(Date.now() / 1000),
    reads: {
      authorizationState: (from, nonce) =>
        publicClient.readContract({ address: cfg.usdc, abi: USDC_ABI, functionName: 'authorizationState', args: [from, nonce] }),
      balanceOf: (address) =>
        publicClient.readContract({ address: cfg.usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [address] }),
    },
    estimateFees: async () => {
      const f = await publicClient.estimateFeesPerGas();
      return { maxFeePerGas: f.maxFeePerGas ?? 0n, maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? 0n };
    },
    writeTransferWithAuthorization: (args, fees) =>
      walletClient.writeContract({
        address: cfg.usdc, abi: USDC_ABI, functionName: 'transferWithAuthorization', args, ...fees,
      } as any),
    waitForReceipt: async (hash) => {
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
      return { status: r.status, logs: r.logs };
    },
    ...extra,
  };
}

export function facilitatorRouter(deps: SettleDeps & { address: Hex }, log: (m: string) => void = () => {}) {
  const router = Router();
  router.use(json({ limit: '64kb' }));
  const network = `eip155:${deps.chainId}`;

  router.get('/supported', (_req, res) => {
    res.json({ kinds: [{ x402Version: 2, scheme: 'exact', network }], extensions: [], signers: { 'eip155:*': [deps.address] } });
  });

  router.post('/verify', async (req, res) => {
    const v = await verifyPayment(req.body, deps);
    log(`verify -> ${v.isValid ? 'valid' : v.invalidReason}`);
    // Never echo the parsed authorization back; the middleware only needs the verdict.
    res.json(v.isValid ? { isValid: true, payer: v.payer } : v);
  });

  router.post('/settle', async (req, res) => {
    try {
      const s = await settlePayment(req.body, deps);
      log(`settle -> ${s.success ? s.transaction : s.errorReason}`);
      res.json(s);
    } catch (e) {
      log(`settle failed: ${(e as Error).message}`);
      res.json({ success: false, errorReason: 'settlement_error', transaction: '', network });
    }
  });
  return router;
}
