// Backup and restore, as orchestrations over injected dependencies, so the order of the
// steps is tested without a browser or a device:
//
//   backup:  read the Flex (BSA Sentry app) -> switch to Ledger Sync, encrypt -> back -> vault
//   restore: check the Flex is empty -> vault -> switch to Ledger Sync, decrypt -> back -> RESTORE
//
// The DMK and the Key Ring transport must never hold the device at the same time, and RESTORE
// must go to BSA Sentry, not Ledger Sync: `withKeyRing` owns that switch both ways.
import { decodeBackup, encodeBackup, restorePayloadOf, type Credentials, type Policy } from '@bsa-sentry/types';
import type { KeyRing } from './keyring.js';

export type FlowDeps = {
  /** Reads the Flex (BSA Sentry open). `policy` is null when no rules are active. */
  readDevice(): Promise<{ policy: Policy | null; credentials: Credentials | null }>;
  putVault(ciphertextB64: string): Promise<void>;
  getVault(): Promise<string | null>;
  /** Releases the DMK, has the user open Ledger Sync, runs `fn`, then switches back. */
  withKeyRing<T>(fn: (kr: KeyRing) => Promise<T>): Promise<T>;
  /** RESTORE on the Flex (BSA Sentry open): the user reviews everything and approves. */
  restore(policy: Policy, credentials: Credentials | null): Promise<void>;
  onStage?(stage: 'checking' | 'reading' | 'fetching' | 'keyring' | 'saving' | 'reviewing' | 'done'): void;
};

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function runBackup(d: FlowDeps): Promise<'backed_up' | 'nothing_to_back_up'> {
  d.onStage?.('reading');
  const { policy, credentials } = await d.readDevice();
  if (!policy?.active) return 'nothing_to_back_up';
  const plain = encodeBackup({ policy, credentials });
  d.onStage?.('keyring');
  const cipher = await d.withKeyRing((kr) => kr.encrypt(plain));
  d.onStage?.('saving');
  await d.putVault(toB64(cipher));
  d.onStage?.('done');
  return 'backed_up';
}

export async function runRestore(d: FlowDeps): Promise<'restored' | 'device_not_empty' | 'no_backup'> {
  d.onStage?.('checking');
  const current = await d.readDevice();
  // Never overwrite live rules by surprise: restore is for a wiped (or brand new) Flex.
  if (current.policy?.active || current.credentials) return 'device_not_empty';
  d.onStage?.('fetching');
  const stored = await d.getVault();
  if (!stored) return 'no_backup';
  d.onStage?.('keyring');
  const plain = await d.withKeyRing(async (kr) => {
    try {
      return await kr.decrypt(fromB64(stored));
    } catch {
      throw new Error('could not decrypt the backup: it was made under another Ledger seed, or it is damaged');
    }
  });
  restorePayloadOf(plain); // validates the version before anything reaches the device
  const { policy, credentials } = decodeBackup(plain);
  d.onStage?.('reviewing');
  await d.restore(policy, credentials);
  d.onStage?.('done');
  return 'restored';
}
