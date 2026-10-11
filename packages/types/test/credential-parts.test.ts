// The relay carries the 18+ credentials as four hex fields (spec §5.5). Each field is
// exactly the byte slice it occupies inside the credentials bundle, so the bridge splits
// what the device returns and the facilitator rebuilds the typed structs without a second
// format to keep in sync.
import { describe, expect, it } from 'vitest';
import {
  CLAIM_AGE_OVER_18, decodeAttestation, decodeDelegation, encodeAttestation, encodeCredentials,
  encodeDelegation, splitCredentials, joinCredentials, type Credentials,
} from '../src/index.js';

const MAIN = '0x21fff03ff9c6a8b845c65ef2aa2fbb09b5da5ce5' as const;
const AGENT = '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' as const;
const b32 = (h: string) => `0x${h.repeat(32)}` as const;

const bundle = (): Credentials => ({
  chainId: 5042002n,
  attestation: { subject: MAIN, claim: CLAIM_AGE_OVER_18, issuedAt: 1_760_000_000n, expiresAt: 1_762_592_000n, evidence: b32('05') },
  attestationSig: `0x1b${'aa'.repeat(64)}`,
  delegation: {
    agent: AGENT, agentName: 'Claude', attestation: b32('03'), claims: [CLAIM_AGE_OVER_18],
    expiresAt: 1_762_592_000n, nonce: b32('04'),
  },
  delegationSig: `0x1c${'bb'.repeat(64)}`,
});

describe('attestation part', () => {
  it('round-trips', () => {
    expect(decodeAttestation(encodeAttestation(bundle().attestation))).toEqual(bundle().attestation);
  });
  it('rejects trailing bytes', () => {
    const b = encodeAttestation(bundle().attestation);
    expect(() => decodeAttestation(Uint8Array.from([...b, 0]))).toThrow(/trailing/i);
  });
});

describe('delegation part', () => {
  it('round-trips', () => {
    expect(decodeDelegation(encodeDelegation(bundle().delegation))).toEqual(bundle().delegation);
  });
  it('rejects trailing bytes', () => {
    const b = encodeDelegation(bundle().delegation);
    expect(() => decodeDelegation(Uint8Array.from([...b, 0]))).toThrow(/trailing/i);
  });
});

describe('the bundle is just the parts in order', () => {
  it('so the parts are byte-identical slices of the bundle', () => {
    const c = bundle();
    const whole = encodeCredentials(c);
    const att = encodeAttestation(c.attestation);
    const del = encodeDelegation(c.delegation);
    // version(1) | flags(1) | chainId(8) | attestation | sig(65) | delegation | sig(65)
    expect(whole.subarray(10, 10 + att.length)).toEqual(att);
    expect(whole.subarray(10 + att.length + 65, 10 + att.length + 65 + del.length)).toEqual(del);
    expect(whole.length).toBe(10 + att.length + 65 + del.length + 65);
  });
});

describe('relay form', () => {
  it('splits a bundle into the four hex fields of the relay message', () => {
    const parts = splitCredentials(bundle());
    expect(Object.keys(parts).sort()).toEqual(['attestation', 'attestationSig', 'delegation', 'delegationSig']);
    expect(parts.attestationSig).toBe(`0x1b${'aa'.repeat(64)}`);
    expect(parts.delegationSig).toBe(`0x1c${'bb'.repeat(64)}`);
    for (const v of Object.values(parts)) expect(v).toMatch(/^0x([0-9a-f]{2})+$/);
  });

  it('joins them back, given the chain the verifier is checking on', () => {
    // The relay form drops the chain id: the facilitator verifies under its own chain,
    // which is the only chain whose signatures it should ever accept.
    expect(joinCredentials(splitCredentials(bundle()), 5042002n)).toEqual(bundle());
  });

  it('rejects a part that is not hex', () => {
    expect(() => joinCredentials({ ...splitCredentials(bundle()), delegation: 'zz' as any }, 5042002n)).toThrow();
  });
});
