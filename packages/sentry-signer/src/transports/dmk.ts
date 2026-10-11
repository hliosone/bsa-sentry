// Browser transport: the Ledger Device Management Kit over WebHID.
//
// Proven in the feasibility tests: DMK 1.11 + device-transport-kit-web-hid 1.2.4 bundle
// with plain Vite and no polyfills, and `sendApdu` carries custom CLA 0xE0 commands.
// This module is only imported by the browser bundle; Node code uses the Speculos or
// node-hid transports instead, because the DMK's ESM entry does not load in plain Node.
import type { Transport } from '../index.js';

/** The slice of the DMK we actually use, so this file does not depend on its full types. */
export interface DmkLike {
  sendApdu(args: { sessionId: string; apdu: Uint8Array }): Promise<{ data: Uint8Array; statusCode: Uint8Array }>;
}

export class DmkTransport implements Transport {
  constructor(private readonly dmk: DmkLike, private readonly sessionId: string) {}

  async send(apdu: Uint8Array): Promise<Uint8Array> {
    // The DMK splits data and status word; the signer expects them concatenated, the way
    // the device actually answers.
    const { data, statusCode } = await this.dmk.sendApdu({ sessionId: this.sessionId, apdu });
    const out = new Uint8Array(data.length + statusCode.length);
    out.set(data, 0);
    out.set(statusCode, data.length);
    return out;
  }
}
