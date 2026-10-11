// The facilitator: the last line of defence before money moves.
//
// It re-verifies everything itself and trusts nothing the merchant middleware forwards
// (security invariant 6). It deliberately holds NO spending rules — those live on the
// Flex — so these tests are about cryptographic and on-chain truth only. Signatures are
// real (a viem account), chain reads are mocked.
import { describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, parseGwei, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EIP712_TYPES, paymentDomain } from '@bsa-sentry/types';
import {
  verifyPayment, settlePayment, feesWithFloor, usdcTransfersIn, MIN_MAX_FEE_PER_GAS,
  type FacilitatorDeps,
} from '../src/facilitator/facilitator.js';
import { USDC_ABI } from '../src/chain.js';

const CHAIN = 5042002;
const NETWORK = `eip155:${CHAIN}`;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const MIRROR = '0xfffffffffffffffffffffffffffffffffffffffe' as const;
const payer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const payTo = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;
const NOW = 1_760_000_000;

type Auth = { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };

async function signedBody(over: Partial<Auth> = {}, reqOver: Record<string, unknown> = {}, signer = payer) {
  const authorization: Auth = {
    from: payer.address, to: payTo, value: '3000000', validAfter: '0',
    validBefore: String(NOW + 300), nonce: `0x${'ab'.repeat(32)}`, ...over,
  };
  const signature = await signer.signTypedData({
    domain: paymentDomain(CHAIN, USDC),
    types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from, to: authorization.to, value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const paymentRequirements = {
    scheme: 'exact', network: NETWORK, amount: '3000000', asset: USDC, payTo,
    maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' }, ...reqOver,
  };
  return {
    x402Version: 2,
    // A copy, as on the wire: the two are separate JSON objects the middleware forwards.
    paymentPayload: { x402Version: 2, payload: { authorization, signature }, accepted: { ...paymentRequirements } },
    paymentRequirements,
  };
}

function deps(over: Partial<FacilitatorDeps> = {}): FacilitatorDeps {
  return {
    chainId: CHAIN,
    usdc: USDC,
    now: () => NOW,
    reads: {
      authorizationState: vi.fn(async () => false),
      balanceOf: vi.fn(async () => 100_000_000n),
    },
    ...over,
  };
}

describe('verify: the happy path', () => {
  it('accepts a correctly signed, funded, fresh authorization', async () => {
    const r = await verifyPayment(await signedBody(), deps());
    expect(r).toMatchObject({ isValid: true, payer: payer.address });
  });

  it('checks the nonce and the balance on chain, for the right address', async () => {
    const d = deps();
    await verifyPayment(await signedBody(), d);
    expect(d.reads.authorizationState).toHaveBeenCalledWith(payer.address, `0x${'ab'.repeat(32)}`);
    expect(d.reads.balanceOf).toHaveBeenCalledWith(payer.address);
  });
});

describe('verify: every way it must fail', () => {
  it('rejects a signature from someone other than `from`', async () => {
    const impostor = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const r = await verifyPayment(await signedBody({}, {}, impostor), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'invalid_signature' });
  });

  it('rejects an authorization whose amount differs from what the merchant asked', async () => {
    const r = await verifyPayment(await signedBody({ value: '2999999' }), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'invalid_amount' });
  });

  it('rejects an authorization to a different payee', async () => {
    const r = await verifyPayment(await signedBody({ to: '0xdd70bd3cde251346c0ddfc7a4db3056bb26f1e50' }), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'invalid_pay_to' });
  });

  it('rejects an expired authorization', async () => {
    const r = await verifyPayment(await signedBody({ validBefore: String(NOW - 1) }), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'authorization_expired' });
  });

  it('rejects one about to expire, which could not be mined in time', async () => {
    const r = await verifyPayment(await signedBody({ validBefore: String(NOW + 3) }), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'authorization_expired' });
  });

  it('rejects one that is not valid yet', async () => {
    const r = await verifyPayment(await signedBody({ validAfter: String(NOW + 60) }), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'authorization_not_yet_valid' });
  });

  it('rejects a nonce that was already used on chain (replay)', async () => {
    const d = deps({ reads: { authorizationState: vi.fn(async () => true), balanceOf: vi.fn(async () => 100_000_000n) } });
    const r = await verifyPayment(await signedBody(), d);
    expect(r).toMatchObject({ isValid: false, invalidReason: 'nonce_already_used' });
  });

  it('rejects a payer without the balance', async () => {
    const d = deps({ reads: { authorizationState: vi.fn(async () => false), balanceOf: vi.fn(async () => 2_999_999n) } });
    const r = await verifyPayment(await signedBody(), d);
    expect(r).toMatchObject({ isValid: false, invalidReason: 'insufficient_funds' });
  });

  it('rejects another network', async () => {
    const r = await verifyPayment(await signedBody({}, { network: 'eip155:84532' }), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'unsupported_scheme_or_network' });
  });

  it('rejects another asset', async () => {
    const r = await verifyPayment(await signedBody({}, { asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e' }), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'invalid_asset' });
  });

  it('rejects a payload with no authorization or signature', async () => {
    const body = await signedBody();
    (body.paymentPayload.payload as any).signature = undefined;
    expect(await verifyPayment(body, deps())).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
    expect(await verifyPayment({} as any, deps())).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
  });

  it('rejects a merchant requirement that disagrees with what the payer accepted', async () => {
    // The middleware forwards both; a facilitator that checked only one could be fed a
    // cheap `accepted` and an expensive `paymentRequirements`, or the reverse.
    const body = await signedBody();
    (body.paymentPayload.accepted as any).payTo = '0xdd70bd3cde251346c0ddfc7a4db3056bb26f1e50';
    expect(await verifyPayment(body, deps())).toMatchObject({ isValid: false, invalidReason: 'requirements_mismatch' });
  });

  it('does not touch the chain at all when the signature is bad', async () => {
    const d = deps();
    const impostor = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    await verifyPayment(await signedBody({}, {}, impostor), d);
    expect(d.reads.balanceOf).not.toHaveBeenCalled();
  });

  it('fails closed when an RPC read throws', async () => {
    const d = deps({ reads: { authorizationState: vi.fn(async () => { throw new Error('rpc down'); }), balanceOf: vi.fn(async () => 1n) } });
    expect(await verifyPayment(await signedBody(), d)).toMatchObject({ isValid: false, invalidReason: 'chain_unavailable' });
  });
});

describe('verify: 18+', () => {
  it('fails closed with AGE_PROOF_REQUIRED when the merchant requires it and no proof is attached', async () => {
    const r = await verifyPayment(await signedBody({}, { extra: { name: 'USDC', version: '2', requires: ['age_over_18'] } }), deps());
    expect(r).toMatchObject({ isValid: false, invalidReason: 'AGE_PROOF_REQUIRED' });
  });

  it('delegates to the age verifier when a proof is attached, and honours its verdict', async () => {
    const body = await signedBody({}, { extra: { name: 'USDC', version: '2', requires: ['age_over_18'] } });
    (body.paymentPayload as any).extensions = { bsaAge: { attestation: '0x01' } };
    const verifyAge = vi.fn(async () => ({ ok: false as const, reason: 'DELEGATION_WRONG_AGENT' }));
    expect(await verifyPayment(body, deps({ verifyAge }))).toMatchObject({ isValid: false, invalidReason: 'DELEGATION_WRONG_AGENT' });
    expect(verifyAge).toHaveBeenCalledWith({ attestation: '0x01' }, payer.address);

    const accept = vi.fn(async () => ({ ok: true as const }));
    expect(await verifyPayment(body, deps({ verifyAge: accept }))).toMatchObject({ isValid: true });
  });

  it('ignores an attached proof when the merchant does not require one', async () => {
    const body = await signedBody();
    (body.paymentPayload as any).extensions = { bsaAge: { junk: true } };
    const verifyAge = vi.fn();
    expect(await verifyPayment(body, deps({ verifyAge }))).toMatchObject({ isValid: true });
    expect(verifyAge).not.toHaveBeenCalled();
  });
});

describe('settle', () => {
  const transferLog = (address: Hex, value: bigint) => ({
    address,
    topics: encodeEventTopics({ abi: USDC_ABI, eventName: 'Transfer', args: { from: payer.address, to: payTo } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: 1n, transactionHash: `0x${'cd'.repeat(32)}`, logIndex: 0, blockHash: `0x${'ef'.repeat(32)}`,
    transactionIndex: 0, removed: false,
  });

  it('floors maxFeePerGas at 20 gwei, because Arc silently drops anything lower', () => {
    expect(MIN_MAX_FEE_PER_GAS).toBe(parseGwei('20'));
    expect(feesWithFloor({ maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('1') }).maxFeePerGas).toBe(parseGwei('20'));
    expect(feesWithFloor({ maxFeePerGas: parseGwei('30'), maxPriorityFeePerGas: parseGwei('2') }).maxFeePerGas).toBe(parseGwei('30'));
    // The priority fee can never exceed the max fee.
    const f = feesWithFloor({ maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('50') });
    expect(f.maxPriorityFeePerGas).toBeLessThanOrEqual(f.maxFeePerGas);
  });

  it('counts only the USDC contract Transfer, ignoring the 18-decimal mirror log', () => {
    const logs = [transferLog(MIRROR, 3_000_000_000_000_000_000n), transferLog(USDC, 3_000_000n)];
    const transfers = usdcTransfersIn(logs as any, USDC);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.value).toBe(3_000_000n);
  });

  it('submits transferWithAuthorization with the split signature and the fee floor', async () => {
    const body = await signedBody();
    const write = vi.fn(async () => `0x${'cd'.repeat(32)}` as Hex);
    const r = await settlePayment(body, {
      ...deps(),
      estimateFees: async () => ({ maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('1') }),
      writeTransferWithAuthorization: write,
      waitForReceipt: async () => ({ status: 'success', logs: [transferLog(MIRROR, 1n), transferLog(USDC, 3_000_000n)] } as any),
    });
    expect(r).toMatchObject({ success: true, transaction: `0x${'cd'.repeat(32)}`, network: NETWORK, payer: payer.address });
    const [args, fees] = write.mock.calls[0]! as unknown as [readonly unknown[], { maxFeePerGas: bigint }];
    expect(args[0]).toBe(payer.address);
    expect(String(args[1]).toLowerCase()).toBe(payTo);
    expect(args[2]).toBe(3_000_000n);
    expect([27, 28]).toContain(args[6]);
    expect(fees.maxFeePerGas).toBe(parseGwei('20'));
  });

  it('never submits a payment that does not verify', async () => {
    const write = vi.fn();
    const impostor = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const r = await settlePayment(await signedBody({}, {}, impostor), {
      ...deps(), estimateFees: vi.fn(), writeTransferWithAuthorization: write, waitForReceipt: vi.fn(),
    });
    expect(r).toMatchObject({ success: false, errorReason: 'invalid_signature' });
    expect(write).not.toHaveBeenCalled();
  });

  it('reports a reverted transaction as a failure', async () => {
    const r = await settlePayment(await signedBody(), {
      ...deps(),
      estimateFees: async () => ({ maxFeePerGas: parseGwei('30'), maxPriorityFeePerGas: 1n }),
      writeTransferWithAuthorization: async () => `0x${'cd'.repeat(32)}` as Hex,
      waitForReceipt: async () => ({ status: 'reverted', logs: [] } as any),
    });
    expect(r).toMatchObject({ success: false, errorReason: 'settlement_failed' });
  });

  it('reports a mined transaction whose USDC transfer does not match as a failure', async () => {
    const r = await settlePayment(await signedBody(), {
      ...deps(),
      estimateFees: async () => ({ maxFeePerGas: parseGwei('30'), maxPriorityFeePerGas: 1n }),
      writeTransferWithAuthorization: async () => `0x${'cd'.repeat(32)}` as Hex,
      waitForReceipt: async () => ({ status: 'success', logs: [transferLog(USDC, 1n)] } as any),
    });
    expect(r).toMatchObject({ success: false, errorReason: 'settlement_mismatch' });
  });
});
