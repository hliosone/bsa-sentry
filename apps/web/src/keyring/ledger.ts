// The real Ledger Key Ring, in the browser — wired exactly as in our feasibility test:
// @ledgerhq/ledger-key-ring-protocol 0.24.0 over @ledgerhq/hw-transport-webhid, application
// id 17 (the same ring as `wallet-cli ring`), with the Ledger Sync app open on the Flex.
//
// Loaded lazily (dynamic import) so the rest of the site never pays for it, and so the DMK and
// this transport are never open on the device at the same time.
import type { KeyRing } from './keyring.js';

const APPLICATION_ID = 17;
const API_BASE_URL = 'https://trustchain.api.live.ledger.com';

export type LedgerKeyRingSession = KeyRing & { close(): Promise<void> };

/**
 * Opens the Key Ring on a Flex that has Ledger Sync open. The first time, the user confirms on
 * the device to create (or join) the trustchain derived from their seed — which is also what
 * lets a wiped Flex with the same seed decrypt the backup later.
 */
export async function openLedgerKeyRing(onDevicePrompt: (on: boolean) => void): Promise<LedgerKeyRingSession> {
  const [{ default: TransportWebHID }, { getSdk }] = await Promise.all([
    import('@ledgerhq/hw-transport-webhid'),
    import('@ledgerhq/ledger-key-ring-protocol'),
  ]);
  const transport = await TransportWebHID.create();
  const withDevice = () => (fn: (t: unknown) => unknown) => fn(transport);
  const sdk = getSdk(false, { applicationId: APPLICATION_ID, name: 'BSA Sentry', apiBaseUrl: API_BASE_URL }, withDevice as any);
  const member = await sdk.initMemberCredentials();
  const { trustchain } = await sdk.getOrCreateTrustchain('webhid', member, {
    onStartRequestUserInteraction: () => onDevicePrompt(true),
    onEndRequestUserInteraction: () => onDevicePrompt(false),
  } as any);
  return {
    // The SDK's type says `object`, but it feeds the value to AES-GCM: it must be bytes.
    encrypt: async (data) => new Uint8Array(await sdk.encryptUserData(trustchain, data as unknown as object)),
    decrypt: async (data) => new Uint8Array(await sdk.decryptUserData(trustchain, data)),
    close: () => transport.close(),
  };
}
