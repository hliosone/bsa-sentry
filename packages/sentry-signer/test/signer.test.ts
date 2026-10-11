// sentry-signer against a fake transport.
//
// The signer is the only thing that talks to the device, from the browser bridge, from the
// Node harness and from the smoke script. Everything that can go wrong on a real Flex is
// reproduced here: a locked device, a closed app, a refusal with its reason, a blocking
// screen, a disconnect mid-command, and two callers racing for the same device.
import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_AGE_OVER_18, REFUSAL_REASON, SW, encodeCredentials, encodePolicy, encodeState,
  splitCredentials, type Credentials, type DeviceState, type Policy,
} from '@bsa-sentry/types';
import {
  AppClosedError, DeviceLockedError, DeviceRefusedError, SentrySigner, TransportError,
  type Transport,
} from '../src/index.js';

const TOKEN = '0x3600000000000000000000000000000000000000' as const;
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;
const AGENT = '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' as const;
const MAIN = '0x21fff03ff9c6a8b845c65ef2aa2fbb09b5da5ce5' as const;

const unhex = (s: string) => Uint8Array.from(s.replace(/^0x/, '').match(/../g) ?? [], (x) => parseInt(x, 16));
const sw = (code: number) => Uint8Array.from([code >> 8, code & 0xff]);
const ok = (data: Uint8Array | string = new Uint8Array()) =>
  Uint8Array.from([...(typeof data === 'string' ? unhex(data) : data), 0x90, 0x00]);

const demoPolicy = (): Policy => ({
  active: true, chainId: 5042002n, token: TOKEN,
  autoMax: 5_000_000n, hardMax: 50_000_000n, budget: 20_000_000n, maxCount: 10,
  payees: [{ address: CAFE, label: 'Cafe Sat' }],
});

const demoState = (): DeviceState => ({
  sessionArmed: true, hasCredentials: false, spent: 3_000_000n, count: 1,
  lastPayment: { label: 'Cafe Sat', value: 3_000_000n }, policy: demoPolicy(),
});

/** Records every APDU and replies from a scripted queue. */
class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  constructor(private replies: (Uint8Array | (() => Promise<Uint8Array>))[]) {}
  async send(apdu: Uint8Array): Promise<Uint8Array> {
    this.sent.push(apdu);
    const next = this.replies.shift();
    if (!next) throw new Error(`fake transport ran out of replies (apdu #${this.sent.length})`);
    return typeof next === 'function' ? next() : next;
  }
  header(i = 0) {
    const a = this.sent[i]!;
    return { cla: a[0], ins: a[1], p1: a[2], p2: a[3], lc: a[4], data: a.subarray(5) };
  }
}

const signerWith = (...replies: (Uint8Array | (() => Promise<Uint8Array>))[]) => {
  const t = new FakeTransport(replies);
  return { t, signer: new SentrySigner(t) };
};

describe('getAddress', () => {
  it('asks for 0xAGENT with P1 1 and returns a checksum-free lowercase address', async () => {
    const { t, signer } = signerWith(ok(unhex(AGENT)));
    expect(await signer.getAddress('agent')).toBe(AGENT);
    expect(t.header()).toMatchObject({ cla: 0xe0, ins: 0x08, p1: 1, p2: 0, lc: 0 });
  });

  it('asks for 0xMAIN with P1 0', async () => {
    const { t, signer } = signerWith(ok(unhex(MAIN)));
    expect(await signer.getAddress('main')).toBe(MAIN);
    expect(t.header().p1).toBe(0);
  });

  it('sets P2 when the address must be shown on the device', async () => {
    const { t, signer } = signerWith(ok(unhex(AGENT)));
    await signer.getAddress('agent', { display: true });
    expect(t.header().p2).toBe(1);
  });

  it('rejects a reply that is not 20 bytes rather than returning a short address', async () => {
    const { signer } = signerWith(ok('aabb'));
    await expect(signer.getAddress('agent')).rejects.toThrow(/20 bytes/i);
  });
});

describe('getState', () => {
  it('decodes the state blob', async () => {
    const { signer } = signerWith(ok(encodeState(demoState())));
    const state = await signer.getState();
    expect(state.spent).toBe(3_000_000n);
    expect(state.policy.payees[0]!.label).toBe('Cafe Sat');
  });
});

describe('setPolicy', () => {
  it('chunks the policy and marks the last chunk', async () => {
    const policy = demoPolicy();
    const { t, signer } = signerWith(ok());
    await signer.setPolicy(policy);
    expect(t.sent).toHaveLength(1);
    expect(t.header()).toMatchObject({ ins: 0x0a, p1: 0x00, p2: 0x00 });
    expect(t.header().data).toEqual(encodePolicy(policy));
  });

  it('splits a policy that needs more than one APDU', async () => {
    const policy: Policy = {
      ...demoPolicy(),
      payees: Array.from({ length: 8 }, (_, i) => ({
        address: `0x${(i + 1).toString(16).padStart(2, '0').repeat(20)}` as const,
        label: 'x'.repeat(16),
      })),
    };
    const { t, signer } = signerWith(ok(), ok());
    await signer.setPolicy(policy);
    expect(t.sent).toHaveLength(2);
    expect(t.header(0)).toMatchObject({ p1: 0x00, p2: 0x80 });
    expect(t.header(1)).toMatchObject({ p1: 0x01, p2: 0x00 });
  });
});

describe('pay', () => {
  const fields = {
    chainId: 5042002n, token: TOKEN, to: CAFE, value: 3_000_000n,
    validAfter: 0n, validBefore: 1_900_000_000n, nonce: `0x${'11'.repeat(32)}` as const,
  };
  const signature = `1b${'aa'.repeat(32)}${'bb'.repeat(32)}`;

  it('builds the 176-byte payload and returns v, r and s', async () => {
    const { t, signer } = signerWith(ok(signature));
    const sig = await signer.pay(fields);
    expect(sig).toEqual({ v: 27, r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` });
    expect(t.header().ins).toBe(0x0b);
    expect(t.header().data).toHaveLength(176);
  });

  it('appends the agent hint after the fields', async () => {
    const { t, signer } = signerWith(ok(signature));
    await signer.pay(fields, { hint: 'Cafe Sat' });
    expect(t.header().data).toHaveLength(176 + 8);
    expect(new TextDecoder().decode(t.header().data.subarray(176))).toBe('Cafe Sat');
  });

  it('refuses to send a hint the device would reject', async () => {
    const { signer } = signerWith(ok(signature));
    await expect(signer.pay(fields, { hint: 'x'.repeat(25) })).rejects.toThrow(/24/);
  });

  it('throws a typed refusal carrying the device reason', async () => {
    const { signer } = signerWith(Uint8Array.from([REFUSAL_REASON.OVER_HARD_MAX, 0x69, 0x85]));
    const err = await signer.pay(fields).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceRefusedError);
    expect(err.reason).toBe('OVER_HARD_MAX');
    expect(String(err)).toMatch(/OVER_HARD_MAX/);
  });

  it('maps every reason byte', async () => {
    for (const [name, byte] of Object.entries(REFUSAL_REASON)) {
      const { signer } = signerWith(Uint8Array.from([byte, 0x69, 0x85]));
      const err = await signer.pay(fields).catch((e) => e);
      expect(err.reason, name).toBe(name);
    }
  });

  it('treats a bare 6985 as a user rejection', async () => {
    const { signer } = signerWith(sw(SW.DENY));
    const err = await signer.pay(fields).catch((e) => e);
    expect(err.reason).toBe('USER_REJECTED');
  });

  it('reports a locked device distinctly, because the fix is different', async () => {
    const { signer } = signerWith(sw(SW.DEVICE_LOCKED));
    const err = await signer.pay(fields).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceLockedError);
    expect(err.bridgeReason).toBe('FLEX_LOCKED');
  });

  it('reports a closed app distinctly', async () => {
    for (const code of [SW.INS_NOT_SUPPORTED, SW.CLA_NOT_SUPPORTED]) {
      const { signer } = signerWith(sw(code));
      const err = await signer.pay(fields).catch((e) => e);
      expect(err, `0x${code.toString(16)}`).toBeInstanceOf(AppClosedError);
      expect(err.bridgeReason).toBe('APP_CLOSED');
    }
  });

  it('explains a blocking screen rather than leaking 0x6901', async () => {
    const { signer } = signerWith(sw(SW.CMD_NOT_ACCEPTED));
    const err = await signer.pay(fields).catch((e) => e);
    expect(String(err)).toMatch(/screen/i);
  });

  it('rejects a signature reply that is not 65 bytes', async () => {
    const { signer } = signerWith(ok('1baabb'));
    await expect(signer.pay(fields)).rejects.toThrow(/65 bytes/i);
  });
});

describe('one command at a time', () => {
  it('queues a second call instead of interleaving APDUs', async () => {
    const order: string[] = [];
    const slow = () =>
      new Promise<Uint8Array>((resolve) => {
        order.push('first-start');
        setTimeout(() => { order.push('first-end'); resolve(ok(unhex(AGENT))); }, 50);
      });
    const fast = async () => { order.push('second-start'); return ok(unhex(MAIN)); };
    const { signer } = signerWith(slow, fast);

    const [a, b] = await Promise.all([signer.getAddress('agent'), signer.getAddress('main')]);
    expect(a).toBe(AGENT);
    expect(b).toBe(MAIN);
    // The second command must not start before the first finishes: the device cannot
    // interleave, and a desynchronised transfer is very hard to recover from.
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('keeps the queue usable after a command fails', async () => {
    const { signer } = signerWith(sw(SW.DEVICE_LOCKED), ok(unhex(AGENT)));
    await expect(signer.getAddress('agent')).rejects.toThrow(DeviceLockedError);
    expect(await signer.getAddress('agent')).toBe(AGENT);
  });
});

describe('timeouts', () => {
  it('waits at least 120 s by default, because the device screen alone takes 60', () => {
    expect(new SentrySigner(new FakeTransport([])).timeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it('gives up after the timeout with a transport error', async () => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<Uint8Array>(() => {});
      const signer = new SentrySigner(new FakeTransport([never]), { timeoutMs: 1000 });
      const pending = signer.getAddress('agent').catch((e) => e);
      await vi.advanceTimersByTimeAsync(1100);
      expect(await pending).toBeInstanceOf(TransportError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('credentials', () => {
  const bundle = (): Credentials => ({
    chainId: 5042002n,
    attestation: {
      subject: MAIN, claim: CLAIM_AGE_OVER_18, issuedAt: 1_760_000_000n,
      expiresAt: 1_762_592_000n, evidence: `0x${'05'.repeat(32)}`,
    },
    attestationSig: `0x1b${'aa'.repeat(64)}`,
    delegation: {
      agent: AGENT, agentName: 'Claude', attestation: `0x${'03'.repeat(32)}`,
      claims: [CLAIM_AGE_OVER_18], expiresAt: 1_762_592_000n, nonce: `0x${'04'.repeat(32)}`,
    },
    delegationSig: `0x1b${'bb'.repeat(64)}`,
  });

  it('reassembles a chunked read', async () => {
    const blob = encodeCredentials(bundle());
    const total = Uint8Array.from([blob.length >> 8, blob.length & 0xff]);
    const first = ok(Uint8Array.from([...total, ...blob.subarray(0, 200)]));
    const second = ok(Uint8Array.from([...total, ...blob.subarray(200)]));
    const { t, signer } = signerWith(first, second);
    const got = await signer.getCredentials();
    expect(got).not.toBeNull();
    expect(got!.delegation.agent).toBe(AGENT);
    expect(t.header(0).p1).toBe(0);
    expect(t.header(1).p1).toBe(1);
  });

  it('returns null when the device has nothing stored', async () => {
    const { signer } = signerWith(ok('0000'));
    expect(await signer.getCredentials()).toBeNull();
  });

  it('gives the relay form the bridge attaches to a payment', async () => {
    const blob = encodeCredentials(bundle());
    const total = Uint8Array.from([blob.length >> 8, blob.length & 0xff]);
    const { signer } = signerWith(
      ok(Uint8Array.from([...total, ...blob.subarray(0, 200)])),
      ok(Uint8Array.from([...total, ...blob.subarray(200)])),
    );
    const wire = await signer.getCredentialsWire();
    expect(wire).toEqual(splitCredentials(bundle()));
  });

  it('gives null in relay form too when nothing is stored', async () => {
    const { signer } = signerWith(ok('0000'));
    expect(await signer.getCredentialsWire()).toBeNull();
  });

  it('stores a bundle in chunks', async () => {
    const { t, signer } = signerWith(ok(), ok());
    await signer.storeCredentials(bundle());
    expect(t.sent.length).toBeGreaterThanOrEqual(1);
    expect(t.header(0).ins).toBe(0x11);
  });
});

describe('status reporting for the bridge', () => {
  it('maps a healthy device to connected', async () => {
    const { signer } = signerWith(ok(encodeState(demoState())));
    expect(await signer.probe()).toMatchObject({ flex: 'connected', session: true });
  });

  it('maps a locked device without throwing', async () => {
    const { signer } = signerWith(sw(SW.DEVICE_LOCKED));
    expect(await signer.probe()).toMatchObject({ flex: 'locked' });
  });

  it('maps a closed app without throwing', async () => {
    const { signer } = signerWith(sw(SW.INS_NOT_SUPPORTED));
    expect(await signer.probe()).toMatchObject({ flex: 'app_closed' });
  });

  it('maps a dead transport to disconnected', async () => {
    const dead: Transport = { send: async () => { throw new Error('device went away'); } };
    expect(await new SentrySigner(dead).probe()).toMatchObject({ flex: 'disconnected' });
  });
});
