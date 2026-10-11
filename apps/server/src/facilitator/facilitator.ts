// The x402 facilitator: /verify and /settle for USDC EIP-3009 on Arc.
//
// Security invariant 6: it re-verifies everything itself and trusts nothing the merchant
// middleware forwards (which, as we measured, enforces nothing). It holds NO spending rules:
// those live on the Flex, and duplicating them here would invite the two to disagree.
//
// Pure functions with injected chain access, so every failure path is unit-tested; the
// Express routes and the real viem clients are wired in routes.ts.
import { getAddress, isAddress, parseEventLogs, parseGwei, recoverTypedDataAddress, type Hex, type Log } from 'viem';
import { CLAIM_AGE_OVER_18, EIP712_TYPES, paymentDomain } from '@bsa-sentry/types';
import { USDC_ABI } from '../chain.js';

/** Arc's mempool silently drops anything below this. */
export const MIN_MAX_FEE_PER_GAS = parseGwei('20');
/** An authorization must outlive submission and mining; this is the margin we demand. */
const MIN_VALIDITY_MARGIN_S = 6n;

export type ChainReads = {
  authorizationState(from: Hex, nonce: Hex): Promise<boolean>;
  balanceOf(address: Hex): Promise<bigint>;
};

export type AgeVerdict = { ok: true } | { ok: false; reason: string };

export type FacilitatorDeps = {
  chainId: number;
  usdc: Hex;
  reads: ChainReads;
  now: () => number;
  /** Checks `extensions.bsaAge` against the payer. Absent until the 18+ module is wired. */
  verifyAge?: (proof: unknown, payer: Hex) => Promise<AgeVerdict>;
};

export type SettleDeps = FacilitatorDeps & {
  estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  writeTransferWithAuthorization(
    args: readonly [Hex, Hex, bigint, bigint, bigint, Hex, number, Hex, Hex],
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  ): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; logs: Log[] }>;
};

type Authorization = { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };

export type VerifyResult =
  | { isValid: true; payer: Hex; authorization: Authorization; signature: Hex }
  | { isValid: false; invalidReason: string; invalidMessage?: string; payer?: Hex };

const network = (chainId: number) => `eip155:${chainId}`;

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && isAddress(a) && isAddress(b) && getAddress(a) === getAddress(b);

function parseAuthorization(raw: any): Authorization | null {
  try {
    if (!raw || !isAddress(raw.from) || !isAddress(raw.to) || !/^0x[0-9a-fA-F]{64}$/.test(raw.nonce)) return null;
    return {
      from: getAddress(raw.from), to: getAddress(raw.to), value: BigInt(raw.value),
      validAfter: BigInt(raw.validAfter), validBefore: BigInt(raw.validBefore), nonce: raw.nonce,
    };
  } catch {
    return null;
  }
}

/** The merchant fields that must agree between what was asked and what the payer accepted. */
const BINDING_FIELDS = ['scheme', 'network', 'amount', 'asset', 'payTo'] as const;

export async function verifyPayment(body: any, deps: FacilitatorDeps): Promise<VerifyResult> {
  const fail = (invalidReason: string, invalidMessage?: string, payer?: Hex): VerifyResult =>
    ({ isValid: false, invalidReason, ...(invalidMessage ? { invalidMessage } : {}), ...(payer ? { payer } : {}) });

  const req = body?.paymentRequirements;
  const payload = body?.paymentPayload;
  const auth = parseAuthorization(payload?.payload?.authorization);
  const signature = payload?.payload?.signature as Hex | undefined;
  if (!req || !auth || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return fail('invalid_payload');
  }

  if (req.scheme !== 'exact' || req.network !== network(deps.chainId)) return fail('unsupported_scheme_or_network', undefined, auth.from);
  if (!same(req.asset, deps.usdc)) return fail('invalid_asset', undefined, auth.from);

  // What the merchant asked for and what the payer accepted must be the same offer.
  const accepted = payload.accepted;
  if (accepted) {
    for (const f of BINDING_FIELDS) {
      const a = accepted[f];
      const b = req[f];
      const equal = f === 'payTo' || f === 'asset' ? same(a, b) : String(a) === String(b);
      if (!equal) return fail('requirements_mismatch', `${f} differs`, auth.from);
    }
  }

  if (!same(auth.to, req.payTo)) return fail('invalid_pay_to', undefined, auth.from);
  if (auth.value !== BigInt(req.amount)) return fail('invalid_amount', `${auth.value} != ${req.amount}`, auth.from);

  const now = BigInt(deps.now());
  if (auth.validBefore <= now + MIN_VALIDITY_MARGIN_S) return fail('authorization_expired', undefined, auth.from);
  if (auth.validAfter > now) return fail('authorization_not_yet_valid', undefined, auth.from);

  // The signature is checked before any RPC call: a forged payment costs us nothing.
  let recovered: Hex;
  try {
    recovered = await recoverTypedDataAddress({
      domain: paymentDomain(deps.chainId, deps.usdc),
      types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
      primaryType: 'TransferWithAuthorization',
      message: auth,
      signature,
    });
  } catch {
    return fail('invalid_signature', undefined, auth.from);
  }
  if (getAddress(recovered) !== auth.from) return fail('invalid_signature', undefined, auth.from);

  // 18+: required by the merchant -> a proof must be attached and must verify. Fail closed.
  const requires: unknown[] = Array.isArray(req.extra?.requires) ? req.extra.requires : [];
  if (requires.includes(CLAIM_AGE_OVER_18)) {
    const proof = payload.extensions?.bsaAge;
    if (!proof) return fail('AGE_PROOF_REQUIRED', undefined, auth.from);
    if (!deps.verifyAge) return fail('AGE_PROOF_REQUIRED', 'age verification is not configured', auth.from);
    const verdict = await deps.verifyAge(proof, auth.from);
    if (!verdict.ok) return fail(verdict.reason, undefined, auth.from);
  }

  let used: boolean;
  let balance: bigint;
  try {
    [used, balance] = await Promise.all([
      deps.reads.authorizationState(auth.from, auth.nonce),
      deps.reads.balanceOf(auth.from),
    ]);
  } catch (e) {
    return fail('chain_unavailable', (e as Error).message, auth.from);
  }
  if (used) return fail('nonce_already_used', undefined, auth.from);
  if (balance < auth.value) return fail('insufficient_funds', `${balance} < ${auth.value}`, auth.from);

  return { isValid: true, payer: auth.from, authorization: auth, signature };
}

export function feesWithFloor(est: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
  const maxFeePerGas = est.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? est.maxFeePerGas : MIN_MAX_FEE_PER_GAS;
  const maxPriorityFeePerGas = est.maxPriorityFeePerGas < maxFeePerGas ? est.maxPriorityFeePerGas : maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * The USDC Transfer events in a receipt. Arc emits every USDC move twice: once from the
 * ERC-20 contract (6 decimals) and once as an 18-decimal native mirror from 0xff…fe.
 * Only the first one is the payment.
 */
export function usdcTransfersIn(logs: Log[], usdc: Hex) {
  return parseEventLogs({ abi: USDC_ABI, eventName: 'Transfer', logs })
    .filter((l) => same(l.address, usdc))
    .map((l) => ({ from: l.args.from, to: l.args.to, value: l.args.value }));
}

export async function settlePayment(body: any, deps: SettleDeps) {
  const net = network(deps.chainId);
  const v = await verifyPayment(body, deps);
  if (!v.isValid) {
    return { success: false, errorReason: v.invalidReason, payer: v.payer, transaction: '', network: net };
  }
  const { authorization: a, signature } = v;
  // viem's r | s | v layout, which is what x402 clients put in the payload.
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  let sigV = parseInt(signature.slice(130, 132), 16);
  if (sigV < 27) sigV += 27;

  const fees = feesWithFloor(await deps.estimateFees());
  const hash = await deps.writeTransferWithAuthorization(
    [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, sigV, r, s],
    fees,
  );
  const receipt = await deps.waitForReceipt(hash);
  if (receipt.status !== 'success') {
    return { success: false, errorReason: 'settlement_failed', payer: a.from, transaction: hash, network: net };
  }
  const transfers = usdcTransfersIn(receipt.logs, deps.usdc);
  const matches = transfers.length === 1
    && same(transfers[0]!.from, a.from) && same(transfers[0]!.to, a.to) && transfers[0]!.value === a.value;
  if (!matches) {
    return { success: false, errorReason: 'settlement_mismatch', payer: a.from, transaction: hash, network: net };
  }
  return { success: true, payer: a.from, transaction: hash, network: net, amount: a.value.toString() };
}
