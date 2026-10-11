// The Key Ring backup format. It is the RESTORE payload (policy, then optionally the
// credentials bundle) behind a version byte, so restoring is: decrypt, strip one byte, send.
// It is only ever stored encrypted under the user's seed (security invariant 8).
import { decodeCredentials, encodeCredentials, type Credentials } from './credentials.js';
import { concat, decodePolicy, encodePolicy, type Policy } from './policy.js';

export const BACKUP_VERSION = 1;

export type Backup = { policy: Policy; credentials: Credentials | null };

export function encodeBackup(b: Backup): Uint8Array {
  if (!b.policy.active) throw new Error('no active rules to back up');
  return concat([
    Uint8Array.of(BACKUP_VERSION),
    encodePolicy(b.policy),
    ...(b.credentials ? [encodeCredentials(b.credentials)] : []),
  ]);
}

/** The bytes RESTORE expects: everything after the version byte. */
export function restorePayloadOf(backup: Uint8Array): Uint8Array {
  if (backup.length === 0) throw new Error('empty backup');
  if (backup[0] !== BACKUP_VERSION) throw new Error(`unsupported backup version ${backup[0]}`);
  return backup.subarray(1);
}

export function decodeBackup(backup: Uint8Array): Backup {
  const body = restorePayloadOf(backup);
  // The policy is self-delimiting; find where it ends by trying the declared payee layout.
  // Reuse the strict decoders: the policy must decode, and so must whatever follows.
  const policyLen = policyLength(body);
  const policy = decodePolicy(body.subarray(0, policyLen));
  const rest = body.subarray(policyLen);
  return { policy, credentials: rest.length === 0 ? null : decodeCredentials(rest) };
}

/** Length of the policy at the start of `b`, from its own header (57 bytes + payees). */
function policyLength(b: Uint8Array): number {
  if (b.length < 57) throw new Error('backup too short');
  let at = 57;
  const count = b[56]!;
  for (let i = 0; i < count; i++) {
    if (at + 21 > b.length) throw new Error('truncated backup');
    at += 21 + b[at + 20]!;
  }
  if (at > b.length) throw new Error('truncated backup');
  return at;
}
