// Speculos transport: one HTTP POST per APDU.
//
// Used by the Node harness and the smoke script. Speculos holds the request open while the
// device shows a screen, so the fetch timeout has to outlive the device's own 60 s.
import type { Transport } from '../index.js';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (x) => parseInt(x, 16));

export class SpeculosTransport implements Transport {
  constructor(
    private readonly baseUrl = process.env.SPECULOS_API ?? 'http://localhost:5000',
    private readonly timeoutMs = 130_000,
  ) {}

  async send(apdu: Uint8Array): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/apdu`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: hex(apdu) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`speculos /apdu returned HTTP ${res.status}`);
    const json = (await res.json()) as { data: string };
    return unhex(json.data);
  }
}
