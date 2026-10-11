// Regenerates fixtures/wire.json: golden byte vectors for the policy / state / credentials
// codecs and the APDU chunker, plus a list of blobs that MUST be rejected.
// device-app/core reads this same file in its host tests, so Rust and TS cannot drift.
import { writeFileSync } from 'node:fs';
import {
  encodePolicy, encodeState, encodeCredentials, encodeChunks, decodePolicy, decodeState, decodeCredentials,
  INS, MAX_PAYEES, MAX_LABEL_BYTES, MAX_CLAIMS, MAX_CLAIM_BYTES, MAX_AGENT_NAME_BYTES,
  type Policy, type DeviceState, type Credentials,
} from '../src/index.js';

const hex = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const TOKEN = '0x3600000000000000000000000000000000000000' as const;
const MAIN = '0x21fff03ff9c6a8b845c65ef2aa2fbb09b5da5ce5' as const;
const AGENT = '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' as const;
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;
const CAVE = '0x0b34839c51d7d6932a9cf00d63b15d58a29265ac' as const;
const RESTO = '0xd4e15888844c2df59cf371917c11a99267917af5' as const;
const A = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(20)}` as const;
const b32 = (h: string) => `0x${h.repeat(32)}` as const;
const sig = (h: string) => `0x1b${h.repeat(64)}` as const;

/** The demo policy from the spec. */
const demo: Policy = {
  active: true, chainId: 5042002n, token: TOKEN,
  autoMax: 5_000_000n, hardMax: 50_000_000n, budget: 20_000_000n, maxCount: 10,
  payees: [
    { address: CAFE, label: 'Cafe Sat' },
    { address: CAVE, label: 'Cave du Coin' },
    { address: RESTO, label: 'Resto' },
  ],
};

const empty: Policy = {
  active: false, chainId: 0n, token: `0x${'00'.repeat(20)}`,
  autoMax: 0n, hardMax: 0n, budget: 0n, maxCount: 0, payees: [],
};

const full: Policy = {
  ...demo,
  payees: Array.from({ length: MAX_PAYEES }, (_, i) => ({ address: A(i + 1), label: 'x'.repeat(MAX_LABEL_BYTES) })),
};

const maxima: Policy = {
  active: true, chainId: 2n ** 64n - 1n, token: `0x${'ff'.repeat(20)}`,
  autoMax: 2n ** 64n - 1n, hardMax: 2n ** 64n - 1n, budget: 2n ** 64n - 1n, maxCount: 0xffff,
  payees: [{ address: A(0xaa), label: 'Café Zürich' }],
};

const creds: Credentials = {
  chainId: 5042002n,
  attestation: { subject: MAIN, claim: 'age_over_18', issuedAt: 1_760_000_000n, expiresAt: 1_762_592_000n, evidence: b32('05') },
  attestationSig: sig('aa'),
  delegation: { agent: AGENT, agentName: 'Claude', attestation: b32('03'), claims: ['age_over_18'], expiresAt: 1_762_592_000n, nonce: b32('04') },
  delegationSig: sig('bb'),
};

const credsMax: Credentials = {
  chainId: 5042002n,
  attestation: { ...creds.attestation, claim: 'c'.repeat(MAX_CLAIM_BYTES) },
  attestationSig: sig('11'),
  delegation: {
    ...creds.delegation, agentName: 'n'.repeat(MAX_AGENT_NAME_BYTES),
    claims: Array.from({ length: MAX_CLAIMS }, (_, i) => `${i}`.repeat(MAX_CLAIM_BYTES)),
  },
  delegationSig: sig('22'),
};

const states: [string, DeviceState][] = [
  ['armed-after-one-coffee', { sessionArmed: true, hasCredentials: false, spent: 3_000_000n, count: 1, lastPayment: { label: 'Cafe Sat', value: 3_000_000n }, policy: demo }],
  ['fresh-device', { sessionArmed: false, hasCredentials: false, spent: 0n, count: 0, lastPayment: null, policy: empty }],
  ['armed-with-credentials', { sessionArmed: true, hasCredentials: true, spent: 17_000_000n, count: 4, lastPayment: { label: 'Cave du Coin', value: 4_500_000n }, policy: demo }],
];

/** Blobs the decoder MUST reject. Rust asserts each one errors. */
function invalidPolicies() {
  const ok = encodePolicy(demo);
  const mutate = (why: string, f: (b: Uint8Array) => Uint8Array) => ({ why, hex: hex(f(Uint8Array.from(ok))) });
  return [
    { why: 'empty buffer', hex: '0x' },
    { why: 'one byte short of the header', hex: hex(ok.slice(0, 56)) },
    mutate('unknown wire version', (b) => { b[0] = 99; return b; }),
    mutate('unknown flag bit set', (b) => { b[1] = 0x02; return b; }),
    mutate('payee count above the maximum', (b) => { b[56] = 9; return b; }),
    mutate('label length above the maximum', (b) => { b[77] = 17; return b; }),
    { why: 'truncated payee list', hex: hex(ok.slice(0, ok.length - 1)) },
    { why: 'trailing byte after the policy', hex: hex(Uint8Array.from([...ok, 0x00])) },
    mutate('label is not valid UTF-8', (b) => { b[78] = 0xff; b[79] = 0xfe; return b; }),
  ];
}

function invalidCredentials() {
  const ok = encodeCredentials(creds);
  const mutate = (why: string, f: (b: Uint8Array) => Uint8Array) => ({ why, hex: hex(f(Uint8Array.from(ok))) });
  const claimCountAt = 2 + 8 + 20 + 1 + 'age_over_18'.length + 8 + 8 + 32 + 65 + 20 + 1 + 'Claude'.length + 32;
  return [
    { why: 'empty buffer (means "no credentials stored", never decoded)', hex: '0x' },
    mutate('unknown wire version', (b) => { b[0] = 9; return b; }),
    mutate('non-zero flags', (b) => { b[1] = 1; return b; }),
    mutate('claim count above the maximum', (b) => { b[claimCountAt] = 5; return b; }),
    mutate('attestation claim is not valid UTF-8', (b) => { b[31] = 0xff; b[32] = 0xfe; return b; }),
    { why: 'truncated blob', hex: hex(ok.slice(0, ok.length - 1)) },
    { why: 'trailing byte', hex: hex(Uint8Array.from([...ok, 0x00])) },
  ];
}

const chunking = [0, 1, 250, 251, 500, 501, 1024].map((n) => ({
  payloadLen: n,
  // payload[i] = i & 0xff, so Rust can regenerate it without storing it
  payloadPattern: 'payload[i] = i & 0xff',
  apdus: encodeChunks(INS.SET_POLICY, Uint8Array.from({ length: n }, (_, i) => i & 0xff)).map(hex),
}));

const bigintToString = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

// Round-trip every vector before writing, so a broken generator cannot freeze a broken fixture.
const policies = [['demo', demo], ['empty', empty], ['full-8-payees', full], ['field-maxima', maxima]] as const;
for (const [name, p] of policies) {
  if (JSON.stringify(decodePolicy(encodePolicy(p)), bigintToString) !== JSON.stringify(p, bigintToString)) {
    throw new Error(`policy "${name}" does not round-trip`);
  }
}
for (const [name, s] of states) {
  if (JSON.stringify(decodeState(encodeState(s)), bigintToString) !== JSON.stringify(s, bigintToString)) {
    throw new Error(`state "${name}" does not round-trip`);
  }
}
for (const [name, c] of [['age-18', creds], ['field-maxima', credsMax]] as const) {
  if (JSON.stringify(decodeCredentials(encodeCredentials(c)), bigintToString) !== JSON.stringify(c, bigintToString)) {
    throw new Error(`credentials "${name}" does not round-trip`);
  }
}

const json = JSON.stringify({
  _comment: 'Generated by scripts/gen-wire-fixtures.ts. Golden byte vectors for the policy / state / credentials codecs and the APDU chunker. Read by TS (vitest) and by Rust (device-app/core host tests). Numbers are decimal strings because JSON has no u64. Testnet addresses only.',
  limits: { MAX_PAYEES, MAX_LABEL_BYTES, MAX_CLAIMS, MAX_CLAIM_BYTES, MAX_AGENT_NAME_BYTES },
  policies: policies.map(([name, p]) => ({ name, hex: hex(encodePolicy(p)), decoded: p })),
  states: states.map(([name, s]) => ({ name, hex: hex(encodeState(s)), decoded: s })),
  credentials: [['age-18', creds], ['field-maxima', credsMax]].map(([name, c]) => ({ name, hex: hex(encodeCredentials(c as Credentials)), decoded: c })),
  chunking,
  invalid: { policies: invalidPolicies(), credentials: invalidCredentials() },
}, bigintToString, 2);

writeFileSync(new URL('../fixtures/wire.json', import.meta.url), json + '\n');
console.log('wrote fixtures/wire.json');
