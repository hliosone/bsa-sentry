// The facilitator's 18+ check (security invariant 6): it trusts neither the server nor the
// merchant, and re-verifies the whole chain from the payment back to our issuer.
//
//   extensions.bsaAge present -> delegation signed (by M) -> delegation.agent == payer
//   -> not expired -> claim present -> delegation.attestation == hash(attestation)
//   -> attestation signed by our issuer -> attestation.subject == M -> not expired
import { describe, expect, it } from 'vitest';
import { hashTypedData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  joinCredentials, CLAIM_AGE_OVER_18, EIP712_TYPES, sentryDomain, splitCredentials, toWireSignature, verifierDomain, type Credentials,
} from '@bsa-sentry/types';
import { ageVerifier, delegationHash } from '../src/facilitator/age.js';

const CHAIN = 5042002;
const NOW = 1_760_000_000;
const issuer = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const user = privateKeyToAccount(`0x${'a2'.repeat(32)}`);   // 0xMAIN
const agent = privateKeyToAccount(`0x${'a3'.repeat(32)}`);  // 0xAGENT, the payer
const stranger = privateKeyToAccount(`0x${'a4'.repeat(32)}`);

type Over = {
  attestation?: Partial<Credentials['attestation']>;
  delegation?: Partial<Credentials['delegation']>;
  attestationSigner?: typeof issuer;
  delegationSigner?: typeof user;
  delegationAttestationHash?: Hex;
};

async function proof(o: Over = {}) {
  const attestation = {
    subject: user.address.toLowerCase() as Hex, claim: CLAIM_AGE_OVER_18,
    issuedAt: BigInt(NOW - 60), expiresAt: BigInt(NOW + 30 * 86400), evidence: `0x${'e1'.repeat(32)}` as Hex,
    ...o.attestation,
  };
  const attestationHash = hashTypedData({
    domain: verifierDomain(CHAIN), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation', message: attestation,
  });
  const delegation = {
    agent: agent.address.toLowerCase() as Hex, agentName: 'Claude', attestation: o.delegationAttestationHash ?? attestationHash,
    claims: [CLAIM_AGE_OVER_18], expiresAt: BigInt(NOW + 30 * 86400), nonce: `0x${'d1'.repeat(32)}` as Hex,
    ...o.delegation,
  };
  const attestationSig = toWireSignature(await (o.attestationSigner ?? issuer).signTypedData({
    domain: verifierDomain(CHAIN), types: { AgeAttestation: EIP712_TYPES.AgeAttestation }, primaryType: 'AgeAttestation', message: attestation,
  }));
  const delegationSig = toWireSignature(await (o.delegationSigner ?? user).signTypedData({
    domain: sentryDomain(CHAIN), types: { AgentDelegation: EIP712_TYPES.AgentDelegation }, primaryType: 'AgentDelegation', message: delegation,
  }));
  // Exactly what the relay carries: four hex fields.
  return splitCredentials({ chainId: BigInt(CHAIN), attestation, attestationSig, delegation, delegationSig });
}

const verify = ageVerifier({ chainId: CHAIN, issuer: issuer.address, now: () => NOW });
const payer = agent.address;

describe('the happy path', () => {
  it('accepts a delegation from the user, for this agent, over an attestation from our issuer', async () => {
    expect(await verify(await proof(), payer)).toEqual({ ok: true });
  });

  it('matches the payer case-insensitively', async () => {
    expect(await verify(await proof(), payer.toLowerCase() as Hex)).toEqual({ ok: true });
  });
});

describe('every link in the chain', () => {
  it('rejects a proof that is not the four hex fields', async () => {
    expect(await verify({ attestation: 'nope' }, payer)).toEqual({ ok: false, reason: 'AGE_PROOF_INVALID' });
    expect(await verify(null, payer)).toEqual({ ok: false, reason: 'AGE_PROOF_INVALID' });
    const p = await proof();
    expect(await verify({ ...p, delegation: '0x00' }, payer)).toEqual({ ok: false, reason: 'AGE_PROOF_INVALID' });
  });

  it('rejects a delegation whose signature does not recover', async () => {
    const p = await proof();
    // Flip a byte inside s: still 65 bytes and v valid, but no longer a signature over this.
    const broken = `${p.delegationSig.slice(0, 100)}${p.delegationSig[100] === 'a' ? 'b' : 'a'}${p.delegationSig.slice(101)}` as Hex;
    const r = await verify({ ...p, delegationSig: broken }, payer);
    expect(r.ok).toBe(false);
    // A corrupted signature either fails to recover, or recovers to someone who is not the
    // subject; both must be refused.
    expect(['DELEGATION_INVALID_SIGNATURE', 'SUBJECT_MISMATCH']).toContain((r as any).reason);
  });

  it('rejects a delegation to another agent: the payer must be the delegated agent', async () => {
    const r = await verify(await proof({ delegation: { agent: stranger.address.toLowerCase() as Hex } }), payer);
    expect(r).toEqual({ ok: false, reason: 'DELEGATION_WRONG_AGENT' });
  });

  it('rejects an expired delegation', async () => {
    expect(await verify(await proof({ delegation: { expiresAt: BigInt(NOW - 1) } }), payer)).toEqual({ ok: false, reason: 'DELEGATION_EXPIRED' });
  });

  it('rejects a delegation that does not carry the 18+ claim', async () => {
    expect(await verify(await proof({ delegation: { claims: ['newsletter'] } }), payer)).toEqual({ ok: false, reason: 'DELEGATION_MISSING_CLAIM' });
  });

  it('rejects a delegation pointing at a different attestation', async () => {
    const r = await verify(await proof({ delegationAttestationHash: `0x${'99'.repeat(32)}` }), payer);
    expect(r).toEqual({ ok: false, reason: 'ATTESTATION_HASH_MISMATCH' });
  });

  it('rejects an attestation not signed by our issuer', async () => {
    expect(await verify(await proof({ attestationSigner: stranger }), payer)).toEqual({ ok: false, reason: 'ATTESTATION_WRONG_ISSUER' });
  });

  it('rejects an attestation about someone else than the delegating user', async () => {
    // Bob borrows Alice's attestation: Bob's delegation over Alice's attestation.
    const r = await verify(await proof({ delegationSigner: stranger }), payer);
    expect(r).toEqual({ ok: false, reason: 'SUBJECT_MISMATCH' });
  });

  it('rejects an expired attestation', async () => {
    expect(await verify(await proof({ attestation: { expiresAt: BigInt(NOW - 1) } }), payer)).toEqual({ ok: false, reason: 'ATTESTATION_EXPIRED' });
  });

  it('rejects an attestation for another claim', async () => {
    expect(await verify(await proof({ attestation: { claim: 'age_over_21' } }), payer)).toEqual({ ok: false, reason: 'ATTESTATION_WRONG_CLAIM' });
  });

  it('rejects a signature made for another chain\'s domain', async () => {
    const otherChain = ageVerifier({ chainId: 84532, issuer: issuer.address, now: () => NOW });
    const r = await otherChain(await proof(), payer);
    expect(r.ok).toBe(false);
  });
});

describe('nationality rights', () => {
  const both = { attestation: { claim: 'age_over_18,jurisdiction:FR' }, delegation: { claims: ['age_over_18', 'jurisdiction:FR'] } };

  it('accepts a delegated nationality right that meets the merchant requirement', async () => {
    expect(await verify(await proof(both), payer, ['jurisdiction_not:US'])).toEqual({ ok: true });
    expect(await verify(await proof(both), payer, ['age_over_18', 'jurisdiction_not:US'])).toEqual({ ok: true });
  });

  it('refuses when the nationality does not meet it', async () => {
    const us = { attestation: { claim: 'jurisdiction:US' }, delegation: { claims: ['jurisdiction:US'] } };
    expect(await verify(await proof(us), payer, ['jurisdiction_not:US'])).toEqual({ ok: false, reason: 'DELEGATION_MISSING_CLAIM' });
  });

  it('refuses a right the user attested but did not delegate to this agent', async () => {
    const ageOnly = { attestation: { claim: 'age_over_18,jurisdiction:FR' }, delegation: { claims: ['age_over_18'] } };
    expect(await verify(await proof(ageOnly), payer, ['jurisdiction_not:US'])).toEqual({ ok: false, reason: 'DELEGATION_MISSING_CLAIM' });
  });

  it('refuses a delegation claiming more than the attestation says', async () => {
    const inflated = { attestation: { claim: 'age_over_18' }, delegation: { claims: ['age_over_18', 'jurisdiction:FR'] } };
    expect(await verify(await proof(inflated), payer, ['jurisdiction_not:US'])).toEqual({ ok: false, reason: 'ATTESTATION_WRONG_CLAIM' });
  });
});

describe('revocation', () => {
  it('refuses a delegation the user revoked, even though everything else verifies', async () => {
    const p = await proof();
    const revoked = new Set<string>();
    const withList = ageVerifier({ chainId: CHAIN, issuer: issuer.address, now: () => NOW, isRevoked: (h) => revoked.has(h) });
    expect(await withList(p, payer)).toEqual({ ok: true });
    revoked.add(delegationHash(CHAIN, joinCredentials(p, BigInt(CHAIN)).delegation));
    expect(await withList(p, payer)).toEqual({ ok: false, reason: 'DELEGATION_REVOKED' });
  });
});
