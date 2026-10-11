// Key Ring backup and restore. Ledger Sync cannot run in Speculos, so the Key Ring sits
// behind an interface: tests use a fake that does REAL authenticated encryption with a test
// key; the browser uses the Ledger Key Ring Protocol, wired as in our feasibility test.
import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_AGE_OVER_18, decodeBackup, encodeBackup, type Credentials, type Policy,
} from '@bsa-sentry/types';
import { FakeKeyRing } from '../src/keyring/fake.js';
import { runBackup, runRestore, type FlowDeps } from '../src/keyring/flows.js';

const policy = (): Policy => ({
  active: true, chainId: 5042002n, token: '0x3600000000000000000000000000000000000000',
  autoMax: 5_000_000n, hardMax: 50_000_000n, budget: 20_000_000n, maxCount: 10,
  payees: [{ address: '0x5069ee8f83b7181f031518d1375eae270f884175', label: 'Cafe Sat' }],
});
const creds = (): Credentials => ({
  chainId: 5042002n,
  attestation: { subject: '0x21fff03ff9c6a8b845c65ef2aa2fbb09b5da5ce5', claim: CLAIM_AGE_OVER_18, issuedAt: 1n, expiresAt: 2n, evidence: `0x${'05'.repeat(32)}` },
  attestationSig: `0x1b${'aa'.repeat(64)}`,
  delegation: { agent: '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf', agentName: 'Claude', attestation: `0x${'03'.repeat(32)}`, claims: [CLAIM_AGE_OVER_18], expiresAt: 2n, nonce: `0x${'04'.repeat(32)}` },
  delegationSig: `0x1c${'bb'.repeat(64)}`,
});

describe('the fake Key Ring encrypts for real', () => {
  it('round-trips bytes', async () => {
    const kr = new FakeKeyRing('seed-a');
    const data = new TextEncoder().encode('rules and badge');
    const enc = await kr.encrypt(data);
    expect(Buffer.from(enc).toString()).not.toContain('rules');
    expect(new TextDecoder().decode(await kr.decrypt(enc))).toBe('rules and badge');
  });

  it('uses a fresh IV every time', async () => {
    const kr = new FakeKeyRing('seed-a');
    const d = new Uint8Array([1, 2, 3]);
    expect(Buffer.from(await kr.encrypt(d)).toString('hex')).not.toBe(Buffer.from(await kr.encrypt(d)).toString('hex'));
  });

  it('cannot decrypt under another seed', async () => {
    const enc = await new FakeKeyRing('seed-a').encrypt(new Uint8Array([1, 2, 3]));
    await expect(new FakeKeyRing('seed-b').decrypt(enc)).rejects.toThrow();
  });

  it('detects tampering', async () => {
    const kr = new FakeKeyRing('seed-a');
    const enc = await kr.encrypt(new Uint8Array([1, 2, 3]));
    enc[enc.length - 1]! ^= 1;
    await expect(kr.decrypt(enc)).rejects.toThrow();
  });
});

/** A fake world: device, vault and Key Ring, recording the order things happen in. */
function world(device: { policy: Policy | null; credentials: Credentials | null }) {
  const log: string[] = [];
  let vault: string | null = null;
  const kr = new FakeKeyRing('user-seed');
  const deps: FlowDeps = {
    readDevice: async () => { log.push('read-device'); return { policy: device.policy, credentials: device.credentials }; },
    putVault: async (b64) => { log.push('put-vault'); vault = b64; },
    getVault: async () => { log.push('get-vault'); return vault; },
    withKeyRing: async (fn) => {
      log.push('release-dmk', 'open-ledger-sync');
      try { return await fn(kr); } finally { log.push('back-to-bsa-sentry', 'reacquire-dmk'); }
    },
    restore: async (p, c) => { log.push('restore'); device.policy = p; device.credentials = c; },
    onStage: (s) => log.push(`stage:${s}`),
  };
  return { deps, log, vaultContent: () => vault, kr };
}

describe('backup', () => {
  it('encrypts exactly what is on the Flex and stores only ciphertext', async () => {
    const w = world({ policy: policy(), credentials: creds() });
    expect(await runBackup(w.deps)).toBe('backed_up');
    const stored = w.vaultContent()!;
    expect(stored).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const plain = await w.kr.decrypt(Uint8Array.from(Buffer.from(stored, 'base64')));
    expect(decodeBackup(plain)).toEqual({ policy: policy(), credentials: creds() });
  });

  it('reads the Flex BEFORE switching to Ledger Sync, and writes the vault after coming back', async () => {
    const w = world({ policy: policy(), credentials: null });
    await runBackup(w.deps);
    const steps = w.log.filter((l) => !l.startsWith('stage:'));
    expect(steps).toEqual(['read-device', 'release-dmk', 'open-ledger-sync', 'back-to-bsa-sentry', 'reacquire-dmk', 'put-vault']);
  });

  it('refuses when there are no rules to back up', async () => {
    const w = world({ policy: null, credentials: null });
    expect(await runBackup(w.deps)).toBe('nothing_to_back_up');
    expect(w.log).not.toContain('put-vault');
  });
});

describe('restore', () => {
  it('restores rules and badge onto a wiped Flex', async () => {
    const original = world({ policy: policy(), credentials: creds() });
    await runBackup(original.deps);
    // Same user, same seed, wiped device, same vault.
    const device = { policy: null as Policy | null, credentials: null as Credentials | null };
    const w = world(device);
    w.deps.getVault = async () => original.vaultContent();
    expect(await runRestore(w.deps)).toBe('restored');
    expect(device.policy).toEqual(policy());
    expect(device.credentials).toEqual(creds());
  });

  it('decrypts in Ledger Sync, then switches back BEFORE sending RESTORE to BSA Sentry', async () => {
    const original = world({ policy: policy(), credentials: null });
    await runBackup(original.deps);
    const w = world({ policy: null, credentials: null });
    w.deps.getVault = async () => { w.log.push('get-vault'); return original.vaultContent(); };
    await runRestore(w.deps);
    const steps = w.log.filter((l) => !l.startsWith('stage:'));
    expect(steps).toEqual(['read-device', 'get-vault', 'release-dmk', 'open-ledger-sync', 'back-to-bsa-sentry', 'reacquire-dmk', 'restore']);
  });

  it('does not overwrite live rules on a Flex that is not empty', async () => {
    const w = world({ policy: policy(), credentials: null });
    expect(await runRestore(w.deps)).toBe('device_not_empty');
    expect(w.log).not.toContain('restore');
    expect(w.log).not.toContain('open-ledger-sync');
  });

  it('says so when there is no backup', async () => {
    const w = world({ policy: null, credentials: null });
    expect(await runRestore(w.deps)).toBe('no_backup');
    expect(w.log).not.toContain('open-ledger-sync');
  });

  it('surfaces a decryption failure (wrong seed) without touching the device', async () => {
    const other = world({ policy: policy(), credentials: null });
    other.deps.withKeyRing = async (fn) => fn(new FakeKeyRing('someone-else'));
    await runBackup(other.deps);
    const w = world({ policy: null, credentials: null });
    w.deps.getVault = async () => other.vaultContent();
    await expect(runRestore(w.deps)).rejects.toThrow(/decrypt/i);
    expect(w.log).not.toContain('restore');
  });

  it('reports each stage for the page', async () => {
    const original = world({ policy: policy(), credentials: null });
    await runBackup(original.deps);
    const w = world({ policy: null, credentials: null });
    w.deps.getVault = async () => original.vaultContent();
    const stages: string[] = [];
    w.deps.onStage = (s) => stages.push(s);
    await runRestore(w.deps);
    expect(stages).toEqual(['checking', 'fetching', 'keyring', 'reviewing', 'done']);
  });
});
