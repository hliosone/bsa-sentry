// POST /topup: submits a TOP_UP authorization the user's Flex signed with 0xMAIN.
//
// The Flex only ever signs a transfer from 0xMAIN to its OWN 0xAGENT, after a review. This route
// checks that before spending any gas (the signature must recover to the logged-in 0xMAIN over a
// transfer to this account's agent, and the money must be there), then submits it — the server
// pays the gas — and confirms the transfer in the receipt, like a payment settlement.
import express from 'express';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { EIP712_TYPES, paymentDomain, toViemSignature } from '@bsa-sentry/types';
import { readSession } from './auth.js';
import { safeRouter } from './safe-router.js';
import { feesWithFloor, usdcTransfersIn, type SettleDeps } from './facilitator/facilitator.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const UINT = /^\d{1,78}$/;
const usdc = (units: bigint) => {
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${units / 1_000_000n}${frac ? `.${frac}` : ''}`;
};

export function topupRouter(o: { secret: string; now?: () => number; deps: SettleDeps; agentOf(account: string): string | undefined }) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const router = safeRouter();
  router.use(express.json({ limit: '8kb' }));

  router.post('/', async (req, res) => {
    const account = readSession(req, o.secret, now);
    if (!account) return res.status(401).json({ error: 'log in with Ledger first' });
    const agent = o.agentOf(account);
    if (!agent) return res.status(409).json({ error: 'open the BSA Sentry tab with your Flex: it tells the server your agent address' });

    const b = req.body ?? {};
    if (![b.value, b.validAfter, b.validBefore].every((x) => typeof x === 'string' && UINT.test(x))
      || typeof b.nonce !== 'string' || !HEX32.test(b.nonce) || typeof b.signature !== 'string' || !SIG.test(b.signature)) {
      return res.status(400).json({ error: 'malformed top-up' });
    }
    const m = {
      from: account as Hex, to: agent as Hex, value: BigInt(b.value),
      validAfter: BigInt(b.validAfter), validBefore: BigInt(b.validBefore), nonce: b.nonce as Hex,
    };
    if (m.value === 0n) return res.status(400).json({ error: 'nothing to top up' });
    if (m.validBefore <= BigInt(now())) return res.status(400).json({ error: 'this authorization has expired: sign a new one' });

    const signature = toViemSignature(b.signature as Hex);
    const signer = await recoverTypedDataAddress({
      domain: paymentDomain(o.deps.chainId, o.deps.usdc),
      types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization', message: m, signature,
    }).catch(() => null);
    if (signer?.toLowerCase() !== account.toLowerCase()) {
      return res.status(400).json({ error: 'the signature is not your main account authorizing a transfer to your agent' });
    }

    const balance = await o.deps.reads.balanceOf(m.from);
    if (balance < m.value) {
      return res.status(400).json({ error: `your main account holds ${usdc(balance)} USDC, less than the ${usdc(m.value)} USDC top-up` });
    }

    const r = `0x${signature.slice(2, 66)}` as Hex;
    const s = `0x${signature.slice(66, 130)}` as Hex;
    let v = parseInt(signature.slice(130, 132), 16);
    if (v < 27) v += 27;
    const hash = await o.deps.writeTransferWithAuthorization(
      [m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, v, r, s],
      feesWithFloor(await o.deps.estimateFees()),
    );
    const receipt = await o.deps.waitForReceipt(hash);
    const t = usdcTransfersIn(receipt.logs, o.deps.usdc);
    const ok = receipt.status === 'success' && t.length === 1
      && t[0]!.from.toLowerCase() === m.from.toLowerCase() && t[0]!.to.toLowerCase() === m.to.toLowerCase() && t[0]!.value === m.value;
    if (!ok) return res.status(502).json({ error: 'the top-up transaction did not move the expected amount', txHash: hash });
    res.json({ txHash: hash, amount: usdc(m.value), from: m.from, to: m.to });
  });

  return router;
}
