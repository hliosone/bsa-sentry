/** Encryption under the user's Ledger seed. The real one is the Ledger Key Ring Protocol. */
export interface KeyRing {
  encrypt(data: Uint8Array): Promise<Uint8Array>;
  decrypt(data: Uint8Array): Promise<Uint8Array>;
}
