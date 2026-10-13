// The facilitator's 18+ check. Security invariant 6: it trusts neither the BSA server nor the
// merchant, and re-verifies the chain from the payer back to our issuer, in this order:
//
//   proof well-formed -> delegation signature recovers (to M) -> delegation.agent == payer
//   -> delegation not expired -> the delegated rights meet the merchant's requirements
//   -> delegation.attestation == EIP-712 hash of the attestation
//   -> attestation signed by OUR issuer -> attestation.subject == M -> attestation not expired
//   -> every delegated right is one the attestation states (no inflating the delegation)
//
// Each failure has its own reason so a refusal can be explained.
import { getAddress, hashTypedData, recoverTypedDataAddress, type Hex } from 'viem';
import {
  CLAIM_AGE_OVER_18, EIP712_TYPES, attestedClaims, joinCredentials, satisfies, sentryDomain, toViemSignature, verifierDomain,
  type CredentialParts, type Credentials,
} from '@bsa-sentry/types';
import type { AgeVerdict } from './facilitator.js';

export type AgeVerifierOptions = { chainId: number; issuer: Hex; now?: () => number };

const isParts = (p: unknown): p is CredentialParts =>
  !!p && typeof p === 'object'
  && (['attestation', 'attestationSig', 'delegation', 'delegationSig'] as const).every((k) => typeof (p as any)[k] === 'string');

export function ageVerifier(opts: AgeVerifierOptions) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const issuer = getAddress(opts.issuer);

  return async (proof: unknown, payer: Hex, requires: string[] = [CLAIM_AGE_OVER_18]): Promise<AgeVerdict> => {
    const fail = (reason: string): AgeVerdict => ({ ok: false, reason });

    let c: Credentials;
    try {
      if (!isParts(proof)) return fail('AGE_PROOF_INVALID');
      // The chain id comes from the facilitator, never from the proof: a signature made under
      // another chain's domain simply fails to recover to the right signers below.
      c = joinCredentials(proof, BigInt(opts.chainId));
    } catch {
      return fail('AGE_PROOF_INVALID');
    }

    // 1. Who delegated? M is whoever signed the delegation.
    let m: Hex;
    try {
      m = getAddress(await recoverTypedDataAddress({
        domain: sentryDomain(opts.chainId),
        types: { AgentDelegation: EIP712_TYPES.AgentDelegation },
        primaryType: 'AgentDelegation',
        message: c.delegation,
        signature: toViemSignature(c.delegationSig),
      }));
    } catch {
      return fail('DELEGATION_INVALID_SIGNATURE');
    }

    // 2. The delegated agent must be the one paying.
    if (getAddress(c.delegation.agent) !== getAddress(payer)) return fail('DELEGATION_WRONG_AGENT');
    // 3. Still valid.
    if (c.delegation.expiresAt <= BigInt(now())) return fail('DELEGATION_EXPIRED');
    // 4. The rights delegated to this agent meet what the merchant requires.
    if (!requires.every((r) => satisfies(r, c.delegation.claims))) return fail('DELEGATION_MISSING_CLAIM');

    // 5. It points at exactly this attestation.
    const attestationHash = hashTypedData({
      domain: verifierDomain(opts.chainId),
      types: { AgeAttestation: EIP712_TYPES.AgeAttestation },
      primaryType: 'AgeAttestation',
      message: c.attestation,
    });
    if (attestationHash.toLowerCase() !== c.delegation.attestation.toLowerCase()) return fail('ATTESTATION_HASH_MISMATCH');

    // 6. The attestation is ours.
    let signer: Hex;
    try {
      signer = getAddress(await recoverTypedDataAddress({
        domain: verifierDomain(opts.chainId),
        types: { AgeAttestation: EIP712_TYPES.AgeAttestation },
        primaryType: 'AgeAttestation',
        message: c.attestation,
        signature: toViemSignature(c.attestationSig),
      }));
    } catch {
      return fail('ATTESTATION_WRONG_ISSUER');
    }
    if (signer !== issuer) return fail('ATTESTATION_WRONG_ISSUER');

    // 7. About the person who delegated, not someone else's badge.
    if (getAddress(c.attestation.subject) !== m) return fail('SUBJECT_MISMATCH');
    // 8. Still valid, and for this claim.
    if (c.attestation.expiresAt <= BigInt(now())) return fail('ATTESTATION_EXPIRED');
    const attested = attestedClaims(c.attestation.claim);
    if (!c.delegation.claims.every((claim) => attested.includes(claim))) return fail('ATTESTATION_WRONG_CLAIM');

    return { ok: true };
  };
}
