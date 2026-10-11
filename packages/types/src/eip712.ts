// EIP-712 domains and struct types. Single source of truth: the device has these exact
// type strings compiled in, and both sides are checked against fixtures/eip712.json.
import type { Hex } from 'viem';

export const USDC_DOMAIN_NAME = 'USDC';
export const USDC_DOMAIN_VERSION = '2';
export const SENTRY_DOMAIN_NAME = 'BSA Sentry';
export const VERIFIER_DOMAIN_NAME = 'BSA Verifier';
export const BSA_DOMAIN_VERSION = '1';

/** USDC's own domain. `from` is always 0xAGENT; the device fills it in itself. */
export const paymentDomain = (chainId: number, verifyingContract: Hex) =>
  ({ name: USDC_DOMAIN_NAME, version: USDC_DOMAIN_VERSION, chainId, verifyingContract }) as const;

/** Login / Bind / AgentDelegation, signed by 0xMAIN. No verifyingContract: nothing on chain reads them. */
export const sentryDomain = (chainId: number) =>
  ({ name: SENTRY_DOMAIN_NAME, version: BSA_DOMAIN_VERSION, chainId }) as const;

/** AgeAttestation, signed by our issuer key and verified by the facilitator. */
export const verifierDomain = (chainId: number) =>
  ({ name: VERIFIER_DOMAIN_NAME, version: BSA_DOMAIN_VERSION, chainId }) as const;

export const EIP712_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
  Login: [
    { name: 'origin', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
  Bind: [
    { name: 'verifier', type: 'string' },
    { name: 'session', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
  ],
  AgentDelegation: [
    { name: 'agent', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'attestation', type: 'bytes32' },
    { name: 'claims', type: 'string[]' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'bytes32' },
  ],
  AgeAttestation: [
    { name: 'subject', type: 'address' },
    { name: 'claim', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'evidence', type: 'bytes32' },
  ],
} as const satisfies Record<string, readonly { name: string; type: string }[]>;

export type Eip712TypeName = keyof typeof EIP712_TYPES;

/** Canonical EIP-712 `encodeType` strings. The device keccaks these byte-for-byte. */
export const TYPE_STRINGS = Object.fromEntries(
  Object.entries(EIP712_TYPES).map(([name, fields]) => [name, `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`]),
) as Record<Eip712TypeName, string>;

/** The claim string the 18+ flow uses everywhere (EUDIW, attestation, delegation, x402 `extra.requires`). */
export const CLAIM_AGE_OVER_18 = 'age_over_18';
