// The page reconnects to an already-approved Flex on load, and the user may click "Connect the
// Flex" at the same moment. Two WebHID opens at once fail on the real device with "An operation
// that changes the device state is in progress": there must only ever be one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

const fake = vi.hoisted(() => ({
  connect: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@ledgerhq/device-management-kit', () => {
  const dmk = {
    connect: (...a: unknown[]) => fake.connect(...a),
    disconnect: async () => undefined,
    getDeviceSessionState: () => ({ subscribe: () => ({ unsubscribe() {} }) }),
    listenToAvailableDevices: () => of([{ id: 'flex' }]),
    startDiscovering: () => of({ id: 'flex' }),
    sendApdu: async () => ({ data: new Uint8Array(), statusCode: new Uint8Array([0x90, 0]) }),
  };
  class DeviceManagementKitBuilder { addTransport() { return this; } build() { return dmk; } }
  return { DeviceManagementKitBuilder, CloseAppCommand: class {}, OpenAppCommand: class {} };
});
vi.mock('@ledgerhq/device-transport-kit-web-hid', () => ({ webHidTransportFactory: {} }));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('navigator', { hid: {} });
  fake.connect = vi.fn(() => new Promise((r) => setTimeout(() => r('session-1'), 50)));
});

describe('one Flex connection at a time', () => {
  it('a click during the automatic reconnect reuses it instead of opening a second one', async () => {
    const { connectFlex, reconnectFlex } = await import('../src/device/flex.js');
    const auto = new Promise<unknown>((resolve) => reconnectFlex(resolve));
    const clicked = connectFlex();
    const [a, b] = await Promise.all([auto, clicked]);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('a click after the reconnect finished returns the live connection, no picker, no reopen', async () => {
    const { connectFlex, reconnectFlex } = await import('../src/device/flex.js');
    const auto = await new Promise<unknown>((resolve) => reconnectFlex(resolve));
    expect(await connectFlex()).toBe(auto);
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });
});
