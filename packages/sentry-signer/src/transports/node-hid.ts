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
    // A variable specifier keeps bundlers and the type checker from resolving a package
    // that only the hardware smoke test needs.
    const specifier = '@ledgerhq/hw-transport-node-hid';
    try {
      mod = await import(specifier);
    } catch (e) {
      throw new Error(
        'install @ledgerhq/hw-transport-node-hid to talk to a real Flex from Node ' +
          '(only needed for the hardware smoke test)',
      );
    }
    const TransportNodeHid = mod.default?.default ?? mod.default ?? mod;
    const list = await TransportNodeHid.list();
    if (list.length === 0) throw new Error('no Ledger device found on USB (is it plugged in and unlocked?)');
    const inner = await TransportNodeHid.open(list[0]);
    // An orange screen waits up to 60 s for a tap; never let the transport give up first.
    inner.setExchangeTimeout?.(125_000);
    return new NodeHidTransport(inner);
  }

  async send(apdu: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await this.inner.exchange(Buffer.from(apdu)));
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
