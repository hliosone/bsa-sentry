// A stand-in Key Ring for tests and Speculos runs (Ledger Sync cannot run in Speculos).
// It does real AES-256-GCM, keyed by SHA-256 of a test secret, so the code paths around it
// (ciphertext only in the vault, tamper and wrong-key failures) are exercised for real.
import type { KeyRing } from './keyring.js';

export class FakeKeyRing implements KeyRing {
  private key: Promise<CryptoKey>;

  constructor(secret: string) {
    this.key = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(`bsa-sentry fake key ring|${secret}`))
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }

  async encrypt(data: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key, data as BufferSource));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return out;
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < 13) throw new Error('ciphertext too short');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) as BufferSource }, await this.key, data.subarray(12) as BufferSource));
  }
}
