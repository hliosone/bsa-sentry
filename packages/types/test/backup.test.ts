// The Key Ring backup: what gets encrypted under the user's seed and stored (as ciphertext
// only) in the vault. It is exactly the RESTORE payload, with a version byte in front, so a
// restore never has to translate between two formats.
import { describe, expect, it } from 'vitest';
import {
  BACKUP_VERSION, CLAIM_AGE_OVER_18, MAX_REASSEMBLY, decodeBackup, encodeBackup, encodeCredentials, encodePolicy,
  restorePayloadOf, type Credentials, type Policy,
} from '../src/index.js';

const policy = (): Policy => ({
  active: true, chainId: 5042002n, token: '0x3600000000000000000000000000000000000000',
  autoMax: 5_000_000n, hardMax: 50_000_000n, budget: 20_000_000n, maxCount: 10,
  payees: [{ address: '0x5069ee8f83b7181f031518d1375eae270f884175', label: 'Cafe Sat' },
    { address: '0xaf592651343680405a6aeac740e9bb17c33be1e4', label: 'Boulangerie' }],
});
const creds = (): Credentials => ({
  chainId: 5042002n,
  attestation: { subject: '0x21fff03ff9c6a8b845c65ef2aa2fbb09b5da5ce5', claim: CLAIM_AGE_OVER_18, issuedAt: 1n, expiresAt: 2n, evidence: `0x${'05'.repeat(32)}` },
  attestationSig: `0x1b${'aa'.repeat(64)}`,
  delegation: { agent: '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf', agentName: 'Claude', attestation: `0x${'03'.repeat(32)}`, claims: [CLAIM_AGE_OVER_18], expiresAt: 2n, nonce: `0x${'04'.repeat(32)}` },
  delegationSig: `0x1c${'bb'.repeat(64)}`,
});

describe('backup codec', () => {
  it('round-trips rules and credentials', () => {
    expect(decodeBackup(encodeBackup({ policy: policy(), credentials: creds() }))).toEqual({ policy: policy(), credentials: creds() });
  });

  it('round-trips rules alone (no 18+ badge)', () => {
    expect(decodeBackup(encodeBackup({ policy: policy(), credentials: null }))).toEqual({ policy: policy(), credentials: null });
  });

  it('is a version byte followed by exactly the RESTORE payload', () => {
    const b = encodeBackup({ policy: policy(), credentials: creds() });
    expect(b[0]).toBe(BACKUP_VERSION);
    expect(restorePayloadOf(b)).toEqual(new Uint8Array([...encodePolicy(policy()), ...encodeCredentials(creds())]));
  });

  it('keeps the merchants the user trusted on the device, since those are part of the rules', () => {
    expect(decodeBackup(encodeBackup({ policy: policy(), credentials: null })).policy.payees.map((p) => p.label)).toContain('Boulangerie');
  });

  it('fits one RESTORE transfer at the maxima', () => {
    const max: Policy = { ...policy(), payees: Array.from({ length: 8 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}` as const, label: 'x'.repeat(16) })) };
    const c = creds();
    c.attestation.claim = 'c'.repeat(32);
    c.delegation.agentName = 'n'.repeat(24);
    c.delegation.claims = Array.from({ length: 4 }, () => 'c'.repeat(32));
    expect(restorePayloadOf(encodeBackup({ policy: max, credentials: c })).length).toBeLessThanOrEqual(MAX_REASSEMBLY);
  });

  it('rejects an unknown version, a truncated blob, or trailing junk', () => {
    const b = encodeBackup({ policy: policy(), credentials: null });
    const v = Uint8Array.from(b); v[0] = 9;
    expect(() => decodeBackup(v)).toThrow(/version/i);
    expect(() => decodeBackup(b.subarray(0, 20))).toThrow();
    expect(() => decodeBackup(new Uint8Array([...b, 0xff]))).toThrow();
    expect(() => decodeBackup(new Uint8Array(0))).toThrow();
  });

  it('refuses to back up an inactive policy: there is nothing worth restoring', () => {
    expect(() => encodeBackup({ policy: { ...policy(), active: false }, credentials: null })).toThrow(/no active rules/i);
  });
});
