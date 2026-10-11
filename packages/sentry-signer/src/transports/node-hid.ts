// Real-Flex transport for Node, over USB HID.
//
// Only used by `scripts/device-smoke.ts` when it runs against hardware (Phase C). The DMK's
// ESM build does not load in plain Node (see docs/DX_NOTES.md), so this goes through
// `@ledgerhq/hw-transport-node-hid`, which is CommonJS and loads fine through interop.
//
// The import is dynamic so that nothing in the browser bundle, and no test that only needs
// Speculos, has to have the package installed.
import type { Transport } from '../index.js';

export class NodeHidTransport implements Transport {
  private constructor(private readonly inner: { exchange(b: Buffer): Promise<Buffer>; close(): Promise<void> }) {}

  static async open(): Promise<NodeHidTransport> {
    let mod: any;
    try {
      mod = await import('@ledgerhq/hw-transport-node-hid');
    } catch (e) {
      throw new Error(
        'install @ledgerhq/hw-transport-node-hid to talk to a real Flex from Node ' +
          '(only needed for the hardware smoke test)',
      );
    }
    const TransportNodeHid = mod.default?.default ?? mod.default ?? mod;
    const list = await TransportNodeHid.list();
    if (list.length === 0) throw new Error('no Ledger device found on USB (is it plugged in and unlocked?)');
    return new NodeHidTransport(await TransportNodeHid.open(list[0]));
  }

  async send(apdu: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await this.inner.exchange(Buffer.from(apdu)));
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
