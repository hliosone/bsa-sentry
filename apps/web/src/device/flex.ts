// The real Flex, over WebHID, through the Ledger DMK.
//
// Proven in our feasibility tests: DMK 1.11 + web-hid transport 1.2.4 with plain Vite and no
// polyfills. The session refresher is DISABLED: it sends its own APDUs in the background,
// which would interleave with ours on a device that handles one command at a time.
import { CloseAppCommand, DeviceManagementKitBuilder, OpenAppCommand, type DeviceManagementKit } from '@ledgerhq/device-management-kit';
import { webHidTransportFactory } from '@ledgerhq/device-transport-kit-web-hid';
import { firstValueFrom } from 'rxjs';
import { SentrySigner } from '@bsa-sentry/sentry-signer';
import { DmkTransport } from '@bsa-sentry/sentry-signer/transports/dmk';

let dmk: DeviceManagementKit | null = null;
const kit = () => (dmk ??= new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build());

export type FlexConnection = {
  signer: SentrySigner;
  disconnect: () => Promise<void>;
  onLost: (cb: () => void) => void;
  /** Best effort: close the current app and open another. False if the device would not. */
  switchApp: (appName: string) => Promise<boolean>;
};

// One connection at a time. The page reconnects on load while the user may click "Connect the
// Flex": two WebHID opens at once fail on the device ("An operation that changes the device
// state is in progress"), so a second caller gets the connection already open or opening.
let current: FlexConnection | null = null;
let opening: Promise<FlexConnection> | null = null;

function openOnce(device: () => Promise<any>): Promise<FlexConnection> {
  if (current) return Promise.resolve(current);
  opening ??= device()
    .then(open)
    .then((c) => {
      current = c;
      c.onLost(() => { if (current === c) current = null; });
      return c;
    })
    .finally(() => { opening = null; });
  return opening;
}

async function open(device: any): Promise<FlexConnection> {
  const sessionId = await kit().connect({ device, sessionRefresherOptions: { isRefresherDisabled: true } });
  const lost: (() => void)[] = [];
  kit().getDeviceSessionState({ sessionId }).subscribe({
    next: (s: any) => { if (s.deviceStatus === 'NOT CONNECTED') lost.forEach((cb) => cb()); },
    complete: () => lost.forEach((cb) => cb()),
    error: () => lost.forEach((cb) => cb()),
  });
  return {
    signer: new SentrySigner(new DmkTransport(kit() as any, sessionId)),
    disconnect: () => {
      current = null;
      return kit().disconnect({ sessionId }).catch(() => undefined);
    },
    onLost: (cb) => lost.push(cb),
    switchApp: async (appName) => {
      // OpenApp only works from the dashboard, so close whatever is open first. The device may
      // ask the user to confirm; any failure falls back to guiding the user by hand.
      try {
        await kit().sendCommand({ sessionId, command: new CloseAppCommand() } as any);
        const r: any = await kit().sendCommand({ sessionId, command: new OpenAppCommand({ appName }) } as any);
        return r?.status === 'SUCCESS';
      } catch {
        return false;
      }
    },
  };
}

export const webHidAvailable = () => typeof navigator !== 'undefined' && 'hid' in navigator;

/** Opens Chrome's device picker. Must be called from a click. */
export async function connectFlex(): Promise<FlexConnection> {
  if (!webHidAvailable()) throw new Error('WebHID unavailable: use Google Chrome (not the Chromium snap)');
  return openOnce(() => firstValueFrom(kit().startDiscovering({})));
}

/**
 * Reconnects without a click to a Flex the user already approved in this browser (after a
 * reload or an app switch on the device). Resolves with the first one that appears.
 */
export function reconnectFlex(onConnected: (c: FlexConnection) => void): () => void {
  if (!webHidAvailable()) return () => undefined;
  let busy = false;
  const sub = kit().listenToAvailableDevices({}).subscribe(async (devices: any[]) => {
    if (busy || devices.length === 0) return;
    busy = true;
    try {
      onConnected(await openOnce(async () => devices[0]));
    } catch {
      busy = false;
    }
  });
  return () => sub.unsubscribe();
}
