// The relay: the server's side of the bridge tab.
//
// The server can only ever REQUEST a signature through it (security invariant 6); the tab
// and the Flex decide. These tests pin down the failure modes that would otherwise leave
// an agent hanging: no tab, a tab that disappears mid-request, a request that outlives the
// device's own timeout, and two agents' requests racing for one Flex.
import { describe, expect, it, vi } from 'vitest';
import { Relay, type TabConnection } from '../src/relay/relay.js';

const TOKEN = '0x3600000000000000000000000000000000000000';
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';

const fields = {
  chainId: 5042002n, token: TOKEN, to: CAFE, value: 3_000_000n,
  validAfter: 0n, validBefore: 1_900_000_000n, nonce: `0x${'11'.repeat(32)}`,
} as const;

const sig = { v: 27, r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` };

class FakeTab implements TabConnection {
  sent: any[] = [];
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  lastRequest() { return this.sent.filter((m) => m.type === 'sign_payment' || m.type === 'get_state').at(-1); }
}

const request = (relay: Relay, account = 'alice') =>
  relay.signPayment(account, { fields, hint: 'Cafe Sat', wantCredentials: false });

describe('with no tab attached', () => {
  it('answers DISCONNECTED at once instead of waiting', async () => {
    const relay = new Relay();
    expect(await request(relay)).toEqual({ ok: false, reason: 'DISCONNECTED' });
  });

  it('reports the account as having no bridge', () => {
    expect(new Relay().status('alice')).toMatchObject({ attached: false });
  });
});

describe('a signature round trip', () => {
  it('sends sign_payment with decimal-string numbers and resolves with the signature', async () => {
    const relay = new Relay();
    const tab = new FakeTab();
    relay.attach('alice', tab);

    const pending = request(relay);
    await vi.waitFor(() => expect(tab.lastRequest()).toBeDefined());
    const msg = tab.lastRequest();
    expect(msg).toMatchObject({
      type: 'sign_payment', hint: 'Cafe Sat', wantCredentials: false,
      fields: { chainId: '5042002', value: '3000000', validAfter: '0', validBefore: '1900000000', to: CAFE },
    });
    expect(typeof msg.id).toBe('string');

    relay.onTabMessage('alice', JSON.stringify({ id: msg.id, ok: true, signature: sig }));
    expect(await pending).toEqual({ ok: true, signature: sig });
  });

  it('passes the device refusal reason through unchanged', async () => {
    const relay = new Relay();
    const tab = new FakeTab();
    relay.attach('alice', tab);
    const pending = request(relay);
    await vi.waitFor(() => expect(tab.lastRequest()).toBeDefined());
    relay.onTabMessage('alice', JSON.stringify({ id: tab.lastRequest().id, ok: false, reason: 'OVER_HARD_MAX' }));
    expect(await pending).toEqual({ ok: false, reason: 'OVER_HARD_MAX' });
  });

  it('carries credentials back when the tab attaches them', async () => {
    const relay = new Relay();
    const tab = new FakeTab();
    relay.attach('alice', tab);
    const pending = relay.signPayment('alice', { fields, wantCredentials: true });
    await vi.waitFor(() => expect(tab.lastRequest()).toBeDefined());
    const credentials = {
      attestation: '0xaa', attestationSig: `0x${'bb'.repeat(65)}`, delegation: '0xcc', delegationSig: `0x${'dd'.repeat(65)}`,
    };
    relay.onTabMessage('alice', JSON.stringify({ id: tab.lastRequest().id, ok: true, signature: sig, credentials }));
    expect(await pending).toEqual({ ok: true, signature: sig, credentials });
  });
});

describe('one request at a time per Flex', () => {
  it('does not send the second request until the first is answered', async () => {
    const relay = new Relay();
    const tab = new FakeTab();
    relay.attach('alice', tab);

    const first = request(relay);
    const second = request(relay);
    await vi.waitFor(() => expect(tab.sent.filter((m) => m.type === 'sign_payment')).toHaveLength(1));
    const firstId = tab.lastRequest().id;

    relay.onTabMessage('alice', JSON.stringify({ id: firstId, ok: true, signature: sig }));
    await first;
    await vi.waitFor(() => expect(tab.sent.filter((m) => m.type === 'sign_payment')).toHaveLength(2));
    relay.onTabMessage('alice', JSON.stringify({ id: tab.lastRequest().id, ok: false, reason: 'USER_REJECTED' }));
    expect(await second).toEqual({ ok: false, reason: 'USER_REJECTED' });
  });

  it('keeps two accounts fully independent', async () => {
    const relay = new Relay();
    const a = new FakeTab();
    const b = new FakeTab();
    relay.attach('alice', a);
    relay.attach('bob', b);
    const pa = request(relay, 'alice');
    const pb = request(relay, 'bob');
    await vi.waitFor(() => { expect(a.lastRequest()).toBeDefined(); expect(b.lastRequest()).toBeDefined(); });
    relay.onTabMessage('bob', JSON.stringify({ id: b.lastRequest().id, ok: true, signature: sig }));
    expect(await pb).toMatchObject({ ok: true });
    // Bob's answer must not have settled Alice's request.
    relay.onTabMessage('alice', JSON.stringify({ id: a.lastRequest().id, ok: false, reason: 'TIMEOUT' }));
    expect(await pa).toEqual({ ok: false, reason: 'TIMEOUT' });
  });

  it('ignores an answer carrying another account\'s request id', async () => {
    const relay = new Relay();
    const a = new FakeTab();
    const b = new FakeTab();
    relay.attach('alice', a);
    relay.attach('bob', b);
    const pa = request(relay, 'alice');
    await vi.waitFor(() => expect(a.lastRequest()).toBeDefined());
    // Bob's tab tries to answer Alice's request: it must have no effect.
    relay.onTabMessage('bob', JSON.stringify({ id: a.lastRequest().id, ok: true, signature: sig }));
    relay.onTabMessage('alice', JSON.stringify({ id: a.lastRequest().id, ok: false, reason: 'USER_REJECTED' }));
    expect(await pa).toEqual({ ok: false, reason: 'USER_REJECTED' });
  });
});

describe('timeouts', () => {
  it('waits 120 s by default, longer than the device\'s own 60 s screen', () => {
    expect(new Relay().timeoutMs).toBe(120_000);
  });

  it('answers TIMEOUT when the tab never replies, and moves on to the next request', async () => {
    vi.useFakeTimers();
    try {
      const relay = new Relay({ timeoutMs: 1000 });
      const tab = new FakeTab();
      relay.attach('alice', tab);
      const first = request(relay);
      const second = request(relay);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await first).toEqual({ ok: false, reason: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      expect(tab.sent.filter((m) => m.type === 'sign_payment')).toHaveLength(2);
      relay.onTabMessage('alice', JSON.stringify({ id: tab.lastRequest().id, ok: true, signature: sig }));
      expect(await second).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a reply that arrives after its request timed out', async () => {
    vi.useFakeTimers();
    try {
      const relay = new Relay({ timeoutMs: 1000 });
      const tab = new FakeTab();
      relay.attach('alice', tab);
      const first = request(relay);
      await vi.advanceTimersByTimeAsync(1001);
      const lateId = tab.lastRequest().id;
      expect(await first).toEqual({ ok: false, reason: 'TIMEOUT' });
      // Must not throw, must not resolve anything else.
      expect(() => relay.onTabMessage('alice', JSON.stringify({ id: lateId, ok: true, signature: sig }))).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('disconnects', () => {
  it('answers DISCONNECTED for the in-flight request and everything queued behind it', async () => {
    const relay = new Relay();
    const tab = new FakeTab();
    relay.attach('alice', tab);
    const first = request(relay);
    const second = request(relay);
    await vi.waitFor(() => expect(tab.lastRequest()).toBeDefined());
    relay.detach('alice', tab);
    expect(await first).toEqual({ ok: false, reason: 'DISCONNECTED' });
    expect(await second).toEqual({ ok: false, reason: 'DISCONNECTED' });
  });

  it('a second tab for the same account replaces the first, which is closed', () => {
    const relay = new Relay();
    const old = new FakeTab();
    const fresh = new FakeTab();
    relay.attach('alice', old);
    relay.attach('alice', fresh);
    expect(old.closed).toBe(true);
    expect(relay.status('alice').attached).toBe(true);
  });

  it('a late detach from the replaced tab does not unhook the new one', async () => {
    const relay = new Relay();
    const old = new FakeTab();
    const fresh = new FakeTab();
    relay.attach('alice', old);
    relay.attach('alice', fresh);
    relay.detach('alice', old);
    expect(relay.status('alice').attached).toBe(true);
    const pending = request(relay);
    await vi.waitFor(() => expect(fresh.lastRequest()).toBeDefined());
    relay.onTabMessage('alice', JSON.stringify({ id: fresh.lastRequest().id, ok: true, signature: sig }));
    expect(await pending).toMatchObject({ ok: true });
  });
});

describe('restore', () => {
  it('sends start_restore to the attached tab', () => {
    const relay = new Relay();
    const tab = new FakeTab();
    relay.attach('alice', tab);
    expect(relay.requestRestore('alice')).toBe(true);
    expect(tab.sent.at(-1)).toMatchObject({ type: 'start_restore' });
  });

  it('reports false when no tab is attached', () => {
    expect(new Relay().requestRestore('alice')).toBe(false);
  });
});

describe('status', () => {
  it('tracks the Flex state from the tab\'s status messages', () => {
    const relay = new Relay();
    relay.attach('alice', new FakeTab());
    relay.onTabMessage('alice', JSON.stringify({ type: 'status', flex: 'locked', session: false }));
    expect(relay.status('alice')).toMatchObject({ attached: true, flex: 'locked', session: false });
    relay.onTabMessage('alice', JSON.stringify({ type: 'status', flex: 'connected', session: true, state: '0x0102' }));
    expect(relay.status('alice')).toMatchObject({ flex: 'connected', session: true, state: '0x0102' });
  });

  it('remembers the 0xAGENT address the tab reported', () => {
    const relay = new Relay();
    relay.attach('alice', new FakeTab());
    relay.onTabMessage('alice', JSON.stringify({ type: 'status', flex: 'connected', session: true, agent: '0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf' }));
    relay.onTabMessage('alice', JSON.stringify({ type: 'status', flex: 'connected', session: false }));
    expect(relay.status('alice').agent).toBe('0xaa6abf8f8c5f003a69d26d12d5a625da77e2d9bf');
  });

  it('notifies listeners, which is what feeds the dashboard', () => {
    const relay = new Relay();
    const seen: any[] = [];
    relay.events.on('status', (e) => seen.push(e));
    relay.attach('alice', new FakeTab());
    relay.onTabMessage('alice', JSON.stringify({ type: 'status', flex: 'connected', session: true }));
    expect(seen.at(-1)).toMatchObject({ account: 'alice', flex: 'connected', session: true });
  });

  it('ignores malformed tab messages without crashing', () => {
    const relay = new Relay();
    relay.attach('alice', new FakeTab());
    expect(() => relay.onTabMessage('alice', 'not json')).not.toThrow();
    expect(() => relay.onTabMessage('alice', JSON.stringify({ type: 'status', flex: 'exploded' }))).not.toThrow();
    expect(relay.status('alice').flex).not.toBe('exploded');
  });
});
