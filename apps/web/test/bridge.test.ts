// The bridge: one Chrome tab that relays between our server and the Flex.
//
// It is the only moving part the user has to keep open, so the tests are about what happens
// when things go wrong: the socket drops, the device locks mid-request, two requests arrive
// at once, the server sends something malformed. Everything here runs on a fake socket and a
// fake signer; the same module runs for real in the browser over WebHID and in Node against
// Speculos (scripts/bridge-harness.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeState, type DeviceState, type Policy, type ServerToTab, type TabToServer,
} from '@bsa-sentry/types';
import { AppClosedError, DeviceLockedError, DeviceRefusedError, TransportError } from '@bsa-sentry/sentry-signer';
import { Bridge, type SocketLike } from '../src/bridge/bridge.js';

const TOKEN = '0x3600000000000000000000000000000000000000';
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';

const policy = (): Policy => ({
  active: true, chainId: 5042002n, token: TOKEN,
  autoMax: 5_000_000n, hardMax: 50_000_000n, budget: 20_000_000n, maxCount: 10,
  payees: [{ address: CAFE, label: 'Cafe Sat' }],
});

const state = (over: Partial<DeviceState> = {}): DeviceState => ({
  sessionArmed: true, hasCredentials: false, spent: 0n, count: 0, lastPayment: null,
  policy: policy(), ...over,
});

/** A socket we can drive from the test: feed it messages, read what the bridge sent. */
class FakeSocket implements SocketLike {
  sent: TabToServer[] = [];
  closed = false;
  private handlers: Record<string, ((e: any) => void)[]> = {};

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.emit('close', {});
  }
  addEventListener(type: string, handler: (e: any) => void) {
    (this.handlers[type] ??= []).push(handler);
  }
  emit(type: string, e: any) {
    for (const h of this.handlers[type] ?? []) h(e);
  }
  /** Pretend the server sent a message. */
  deliver(msg: unknown) {
    this.emit('message', { data: JSON.stringify(msg) });
  }
  open() {
    this.emit('open', {});
  }
  get replies() {
    return this.sent.filter((m) => 'id' in m) as Extract<TabToServer, { id: string }>[];
  }
  get statuses() {
    return this.sent.filter((m) => 'type' in m && m.type === 'status') as Extract<TabToServer, { type: 'status' }>[];
  }
}

/** A signer whose every method can be scripted. */
function fakeSigner(over: Partial<Record<string, any>> = {}) {
  return {
    getState: vi.fn(async () => state()),
    probe: vi.fn(async () => ({ flex: 'connected' as const, session: true, state: state() })),
    pay: vi.fn(async () => ({ v: 27 as const, r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` })),
    getCredentials: vi.fn(async () => null),
    getAddress: vi.fn(async () => '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf'),
    ...over,
  };
}

const signPayment = (over: Partial<any> = {}): ServerToTab => ({
  id: 'req-1',
  type: 'sign_payment',
  fields: {
    chainId: '5042002', token: TOKEN, to: CAFE, value: '3000000',
    validAfter: '0', validBefore: '1900000000', nonce: `0x${'11'.repeat(32)}`,
  },
  hint: 'Cafe Sat',
  wantCredentials: false,
  ...over,
}) as unknown as ServerToTab;

function start(signer: ReturnType<typeof fakeSigner>) {
  const sockets: FakeSocket[] = [];
  const bridge = new Bridge({
    signer: signer as any,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    reconnectDelayMs: 10,
  });
  bridge.start();
  return { bridge, sockets, socket: () => sockets[sockets.length - 1]! };
}

describe('connecting', () => {
  it('reports its status as soon as the socket opens, without being asked', async () => {
    const signer = fakeSigner();
    const { socket } = start(signer);
    socket().open();
    await vi.waitFor(() => expect(socket().statuses.length).toBeGreaterThan(0));
    expect(socket().statuses[0]).toMatchObject({ type: 'status', flex: 'connected', session: true });
  });

  it('includes the device state so the dashboard can mirror the budget', async () => {
    const { socket } = start(fakeSigner());
    socket().open();
    await vi.waitFor(() => expect(socket().statuses.length).toBeGreaterThan(0));
    expect(socket().statuses[0]!.state).toBe(`0x${Buffer.from(encodeState(state())).toString('hex')}`);
  });

  it('reports the 0xAGENT address, read from the device once', async () => {
    const signer = fakeSigner();
    const { socket } = start(signer);
    socket().open();
    await vi.waitFor(() => expect(socket().statuses.length).toBeGreaterThan(0));
    expect(socket().statuses[0]).toMatchObject({ agent: '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' });
    socket().deliver({ id: 'st', type: 'get_state' });
    await vi.waitFor(() => expect(socket().statuses.length).toBeGreaterThan(1));
    expect(signer.getAddress).toHaveBeenCalledTimes(1);
  });

  it('reports a locked Flex instead of pretending to be connected', async () => {
    const signer = fakeSigner({ probe: vi.fn(async () => ({ flex: 'locked' as const, session: false })) });
    const { socket } = start(signer);
    socket().open();
    await vi.waitFor(() => expect(socket().statuses.length).toBeGreaterThan(0));
    expect(socket().statuses[0]).toMatchObject({ flex: 'locked', session: false });
  });
});

describe('sign_payment', () => {
  let signer: ReturnType<typeof fakeSigner>;
  let h: ReturnType<typeof start>;

  beforeEach(() => {
    signer = fakeSigner();
    h = start(signer);
    h.socket().open();
  });

  it('passes the fields to the device and returns the signature', async () => {
    h.socket().deliver(signPayment());
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(1));

    expect(signer.pay).toHaveBeenCalledWith(
      {
        chainId: 5042002n, token: TOKEN, to: CAFE, value: 3_000_000n,
        validAfter: 0n, validBefore: 1_900_000_000n, nonce: `0x${'11'.repeat(32)}`,
      },
      { hint: 'Cafe Sat' },
    );
    expect(h.socket().replies[0]).toEqual({
      id: 'req-1', ok: true, signature: { v: 27, r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` },
    });
  });

  it('answers with the device reason when the Flex refuses', async () => {
    signer.pay = vi.fn(async () => { throw new DeviceRefusedError('OVER_HARD_MAX'); });
    h.socket().deliver(signPayment());
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(1));
    expect(h.socket().replies[0]).toEqual({ id: 'req-1', ok: false, reason: 'OVER_HARD_MAX' });
  });

  it('answers FLEX_LOCKED and APP_CLOSED distinctly, so the agent can tell the user what to do', async () => {
    for (const [error, reason] of [[new DeviceLockedError(), 'FLEX_LOCKED'], [new AppClosedError(), 'APP_CLOSED']] as const) {
      const s = fakeSigner({ pay: vi.fn(async () => { throw error; }) });
      const local = start(s);
      local.socket().open();
      local.socket().deliver(signPayment());
      await vi.waitFor(() => expect(local.socket().replies).toHaveLength(1));
      expect(local.socket().replies[0]).toEqual({ id: 'req-1', ok: false, reason });
    }
  });

  it('answers DISCONNECTED when the transport dies', async () => {
    signer.pay = vi.fn(async () => { throw new TransportError('gone'); });
    h.socket().deliver(signPayment());
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(1));
    expect(h.socket().replies[0]).toEqual({ id: 'req-1', ok: false, reason: 'DISCONNECTED' });
  });

  it('never leaves a request unanswered, even on an unexpected error', async () => {
    signer.pay = vi.fn(async () => { throw new Error('something nobody predicted'); });
    h.socket().deliver(signPayment());
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(1));
    // The server waits up to 120 s on each request; silence would stall the agent.
    expect(h.socket().replies[0]).toMatchObject({ id: 'req-1', ok: false });
  });

  it('handles requests one at a time, in order', async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    signer.pay = vi.fn(async () => {
      order.push('start');
      await new Promise<void>((r) => releases.push(r));
      order.push('end');
      return { v: 27 as const, r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` };
    });

    h.socket().deliver(signPayment({ id: 'a' }));
    h.socket().deliver(signPayment({ id: 'b' }));

    // The second request must not have touched the device yet: the Flex answers one
    // command at a time, and interleaving them desynchronises the protocol.
    await vi.waitFor(() => expect(order).toEqual(['start']));
    releases[0]!();
    await vi.waitFor(() => expect(order).toEqual(['start', 'end', 'start']));
    releases[1]!();

    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(2));
    expect(h.socket().replies.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('ignores a malformed request rather than passing it to the device', async () => {
    h.socket().deliver({ id: 'bad', type: 'sign_payment', fields: { to: 'nope' }, wantCredentials: false });
    h.socket().deliver(signPayment({ id: 'good' }));
    await vi.waitFor(() => expect(h.socket().replies.some((r) => r.id === 'good')).toBe(true));
    expect(signer.pay).toHaveBeenCalledTimes(1);
    const bad = h.socket().replies.find((r) => r.id === 'bad');
    if (bad) expect(bad).toMatchObject({ ok: false });
  });

  it('ignores a message that is not JSON', async () => {
    h.socket().emit('message', { data: 'not json at all' });
    h.socket().deliver(signPayment({ id: 'after' }));
    await vi.waitFor(() => expect(h.socket().replies.some((r) => r.id === 'after')).toBe(true));
  });
});

describe('credentials', () => {
  it('are attached only when the server asks', async () => {
    const credentials = {
      attestation: `0x${'aa'.repeat(120)}`, attestationSig: `0x${'bb'.repeat(65)}`,
      delegation: `0x${'cc'.repeat(140)}`, delegationSig: `0x${'dd'.repeat(65)}`,
    };
    const signer = fakeSigner({ getCredentialsWire: vi.fn(async () => credentials) });
    const h = start(signer as any);
    h.socket().open();

    h.socket().deliver(signPayment({ id: 'no-creds', wantCredentials: false }));
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(1));
    expect(h.socket().replies[0]).not.toHaveProperty('credentials');

    h.socket().deliver(signPayment({ id: 'creds', wantCredentials: true }));
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(2));
    expect(h.socket().replies[1]).toMatchObject({ id: 'creds', ok: true, credentials });
  });

  it('attaches credentials stored on the Flex AFTER an earlier request (no stale cache)', async () => {
    const credentials = {
      attestation: `0x${'aa'.repeat(120)}`, attestationSig: `0x${'bb'.repeat(65)}`,
      delegation: `0x${'cc'.repeat(140)}`, delegationSig: `0x${'dd'.repeat(65)}`,
    };
    let stored: typeof credentials | null = null;
    const signer = fakeSigner({ getCredentialsWire: vi.fn(async () => stored) });
    const h = start(signer as any);
    h.socket().open();
    h.socket().deliver(signPayment({ id: 'before', wantCredentials: true }));
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(1));
    expect(h.socket().replies[0]).not.toHaveProperty('credentials');

    stored = credentials; // the user just did the 18+ flow on the website
    h.socket().deliver(signPayment({ id: 'after', wantCredentials: true }));
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(2));
    expect(h.socket().replies[1]).toMatchObject({ id: 'after', credentials });

    stored = null; // and wiped them (or the Flex was reset)
    h.socket().deliver(signPayment({ id: 'wiped', wantCredentials: true }));
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(3));
    expect(h.socket().replies[2]).not.toHaveProperty('credentials');
  });

  it('still signs when the device holds no credentials', async () => {
    const signer = fakeSigner({ getCredentialsWire: vi.fn(async () => null) });
    const h = start(signer as any);
    h.socket().open();
    h.socket().deliver(signPayment({ id: 'x', wantCredentials: true }));
    await vi.waitFor(() => expect(h.socket().replies).toHaveLength(1));
    expect(h.socket().replies[0]).toMatchObject({ id: 'x', ok: true });
    expect(h.socket().replies[0]).not.toHaveProperty('credentials');
  });
});

describe('get_state', () => {
  it('answers with a fresh status message', async () => {
    const signer = fakeSigner();
    const h = start(signer);
    h.socket().open();
    await vi.waitFor(() => expect(h.socket().statuses).toHaveLength(1));
    h.socket().deliver({ id: 'st', type: 'get_state' });
    await vi.waitFor(() => expect(h.socket().statuses.length).toBeGreaterThan(1));
    expect(signer.probe).toHaveBeenCalledTimes(2);
  });
});

describe('page actions', () => {
  it('refresh() re-reads the device and reports a status, on demand', async () => {
    const signer = fakeSigner();
    const { bridge, socket } = start(signer);
    socket().open();
    await vi.waitFor(() => expect(signer.probe).toHaveBeenCalledTimes(1));
    await bridge.refresh();
    expect(signer.probe).toHaveBeenCalledTimes(2);
    expect(socket().statuses.length).toBe(2);
  });

  it('refresh() still resolves when the device cannot be probed (a session closed by an app switch)', async () => {
    const signer = fakeSigner();
    const { bridge, socket } = start(signer);
    socket().open();
    await vi.waitFor(() => expect(signer.probe).toHaveBeenCalledTimes(1));
    signer.probe.mockRejectedValueOnce(new Error('session closed'));
    await expect(bridge.refresh()).resolves.toBeUndefined();
  });

  it('exclusive() runs a page command in the same queue as relay requests', async () => {
    const order: string[] = [];
    let release!: () => void;
    const signer = fakeSigner({
      pay: vi.fn(async () => { order.push('pay-start'); await new Promise<void>((r) => { release = r; }); order.push('pay-end'); return { v: 27, r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` }; }),
    });
    const { bridge, socket } = start(signer);
    socket().open();
    socket().deliver(signPayment());
    await vi.waitFor(() => expect(order).toEqual(['pay-start']));
    const pageCommand = bridge.exclusive(async () => { order.push('page'); return 42; });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['pay-start']); // the page waits its turn
    release();
    expect(await pageCommand).toBe(42);
    expect(order).toEqual(['pay-start', 'pay-end', 'page']);
  });
});

describe('start_restore', () => {
  it('hands the request to the page without touching the device', async () => {
    const signer = fakeSigner();
    const onRestoreRequested = vi.fn();
    const sockets: FakeSocket[] = [];
    const bridge = new Bridge({ signer: signer as any, connect: () => { const s = new FakeSocket(); sockets.push(s); return s; }, onRestoreRequested });
    bridge.start();
    sockets[0]!.open();
    sockets[0]!.deliver({ id: 'r1', type: 'start_restore' });
    await vi.waitFor(() => expect(onRestoreRequested).toHaveBeenCalledTimes(1));
    expect(signer.pay).not.toHaveBeenCalled();
  });
});

describe('reconnection', () => {
  it('opens a new socket after the old one closes', async () => {
    const { sockets, socket } = start(fakeSigner());
    socket().open();
    expect(sockets).toHaveLength(1);
    socket().close();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
  });

  it('stops reconnecting once the bridge is stopped', async () => {
    const { bridge, sockets, socket } = start(fakeSigner());
    socket().open();
    bridge.stop();
    socket().close();
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets).toHaveLength(1);
  });

  it('stays off when another tab replaced it, so two tabs never take turns on the Flex', async () => {
    const signer = fakeSigner();
    const { bridge, sockets, socket } = start(signer);
    socket().open();
    await vi.waitFor(() => expect(signer.probe).toHaveBeenCalledTimes(1));
    socket().emit('close', { code: 4001 });
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets).toHaveLength(1);
    expect(bridge.getStatus().socket).toBe('replaced');
    expect(signer.probe).toHaveBeenCalledTimes(1);
  });

  it('does no work on a timer: nothing happens until the server sends something', async () => {
    // Chrome throttles timers in a hidden tab to about one tick a minute, so the bridge
    // must be driven by socket messages only. If it polled, probe() would keep firing.
    const signer = fakeSigner();
    const { socket } = start(signer);
    socket().open();
    await vi.waitFor(() => expect(signer.probe).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(signer.probe, 'the bridge must not poll the device').toHaveBeenCalledTimes(1);
  });
});
