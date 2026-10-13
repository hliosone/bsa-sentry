// The relay: the server's side of the bridge tab.
//
// The server can only REQUEST a signature through here (security invariant 6). One tab per
// account; one request at a time per account, because the Flex answers one command at a
// time; and every request settles exactly once — signed, refused with a reason, TIMEOUT
// after 120 s, or DISCONNECTED — so an agent is never left waiting on silence.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseTabToServer, type BridgeReason, type PaymentFields } from '@bsa-sentry/types';

export interface TabConnection {
  send(data: string): void;
  close(): void;
}

export type RelayAnswer =
  | { ok: true; signature: { v: 27 | 28; r: `0x${string}`; s: `0x${string}` }; credentials?: Record<string, `0x${string}`> }
  | { ok: false; reason: BridgeReason };

export type TabStatus = {
  attached: boolean;
  flex: 'connected' | 'locked' | 'app_closed' | 'disconnected';
  session: boolean;
  state?: `0x${string}`;
  /** The Flex's 0xAGENT, as reported by its tab. */
  agent?: `0x${string}`;
  updatedAt?: number;
};

type Job = {
  id: string;
  message: Record<string, unknown>;
  resolve: (a: RelayAnswer) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type Account = {
  tab: TabConnection | null;
  status: TabStatus;
  queue: Job[];
  inFlight: Job | null;
};

/** Numbers travel as decimal strings: JSON cannot carry a uint256 without losing precision. */
const toWire = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export class Relay {
  readonly timeoutMs: number;
  /** `status`, `request` and `answer` events, for the dashboard feed. */
  readonly events = new EventEmitter();
  private accounts = new Map<string, Account>();

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  // ------------------------------------------------------------------ tabs

  /** A second tab for the same account replaces the first: one bridge per Flex. */
  attach(account: string, tab: TabConnection) {
    const a = this.account(account);
    if (a.tab && a.tab !== tab) {
      try { a.tab.close(); } catch { /* already gone */ }
    }
    a.tab = tab;
    a.status = { ...a.status, attached: true };
    this.emitStatus(account);
    this.pump(account);
  }

  /** Called when a tab's socket closes. A late close from a replaced tab is ignored. */
  detach(account: string, tab: TabConnection) {
    const a = this.accounts.get(account);
    if (!a || a.tab !== tab) return;
    a.tab = null;
    // The agent address never changes for an account's Flex: keep it, so balances and history
    // still load while the tab reconnects (the tunnel drops idle sockets every couple of minutes).
    a.status = { attached: false, flex: 'disconnected', session: false, ...(a.status.agent ? { agent: a.status.agent } : {}) };
    const pending = [...(a.inFlight ? [a.inFlight] : []), ...a.queue];
    a.inFlight = null;
    a.queue = [];
    for (const job of pending) this.settle(job, { ok: false, reason: 'DISCONNECTED' });
    this.emitStatus(account);
  }

  status(account: string): TabStatus {
    return { ...(this.accounts.get(account)?.status ?? { attached: false, flex: 'disconnected', session: false }) };
  }

  // ------------------------------------------------------------------ requests

  signPayment(
    account: string,
    req: { fields: PaymentFields | Record<string, unknown>; hint?: string; wantCredentials: boolean },
  ): Promise<RelayAnswer> {
    return this.enqueue(account, {
      type: 'sign_payment',
      fields: req.fields,
      ...(req.hint ? { hint: req.hint } : {}),
      wantCredentials: req.wantCredentials,
    });
  }

  /** Asks the tab to start the restore flow. Fire and forget: the user drives it on the device. */
  requestRestore(account: string): boolean {
    const a = this.accounts.get(account);
    if (!a?.tab) return false;
    a.tab.send(toWire({ id: randomUUID(), type: 'start_restore' }));
    return true;
  }

  /** Asks the tab for a fresh status; resolves once it has been sent (the status arrives as an event). */
  refreshState(account: string): boolean {
    const a = this.accounts.get(account);
    if (!a?.tab) return false;
    a.tab.send(toWire({ id: randomUUID(), type: 'get_state' }));
    return true;
  }

  /**
   * Asks the tab for a new status and waits for it, up to `timeoutMs`. The tab reports only when
   * something happens, so the cached status can be stale (a session armed on the Flex since).
   */
  freshStatus(account: string, timeoutMs = 4000): Promise<TabStatus> {
    if (!this.refreshState(account)) return Promise.resolve(this.status(account));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.events.off('status', onStatus);
        resolve(this.status(account));
      };
      const onStatus = (e: { account: string }) => { if (e.account === account) done(); };
      const timer = setTimeout(done, timeoutMs);
      this.events.on('status', onStatus);
    });
  }

  private enqueue(account: string, message: Record<string, unknown>): Promise<RelayAnswer> {
    const a = this.account(account);
    if (!a.tab) return Promise.resolve({ ok: false, reason: 'DISCONNECTED' });
    return new Promise<RelayAnswer>((resolve) => {
      a.queue.push({ id: randomUUID(), message, resolve });
      this.pump(account);
    });
  }

  /** Sends the next queued job if nothing is in flight. */
  private pump(account: string) {
    const a = this.accounts.get(account);
    if (!a || !a.tab || a.inFlight) return;
    const job = a.queue.shift();
    if (!job) return;
    a.inFlight = job;
    job.timer = setTimeout(() => {
      if (a.inFlight !== job) return;
      a.inFlight = null;
      this.settle(job, { ok: false, reason: 'TIMEOUT' });
      this.pump(account);
    }, this.timeoutMs);
    this.events.emit('request', { account, id: job.id, message: job.message });
    try {
      a.tab.send(toWire({ id: job.id, ...job.message }));
    } catch {
      a.inFlight = null;
      this.settle(job, { ok: false, reason: 'DISCONNECTED' });
      this.pump(account);
    }
  }

  private settle(job: Job, answer: RelayAnswer) {
    if (job.timer) clearTimeout(job.timer);
    job.resolve(answer);
  }

  // ------------------------------------------------------------------ messages from the tab

  onTabMessage(account: string, raw: string) {
    const a = this.accounts.get(account);
    if (!a) return;
    let msg: ReturnType<typeof parseTabToServer>;
    try {
      msg = parseTabToServer(JSON.parse(raw));
    } catch {
      return; // malformed: never let it touch a pending request
    }

    if ('type' in msg && msg.type === 'status') {
      a.status = {
        attached: true, flex: msg.flex, session: msg.session,
        ...(msg.state ? { state: msg.state } : {}),
        // Keep a previously reported address if this status omits it.
        ...(msg.agent ?? a.status.agent ? { agent: msg.agent ?? a.status.agent } : {}),
        updatedAt: Date.now(),
      };
      this.emitStatus(account);
      return;
    }

    // An answer is only accepted for THIS account's in-flight request. Another tab cannot
    // settle it, and a late answer to a timed-out request is dropped.
    if (!('id' in msg) || !a.inFlight || a.inFlight.id !== msg.id) return;
    const job = a.inFlight;
    a.inFlight = null;
    const answer: RelayAnswer = msg.ok
      ? { ok: true, signature: msg.signature, ...(msg.credentials ? { credentials: msg.credentials } : {}) }
      : { ok: false, reason: msg.reason };
    this.events.emit('answer', { account, id: job.id, answer });
    this.settle(job, answer);
    this.pump(account);
  }

  // ------------------------------------------------------------------ internals

  private account(id: string): Account {
    let a = this.accounts.get(id);
    if (!a) {
      a = { tab: null, status: { attached: false, flex: 'disconnected', session: false }, queue: [], inFlight: null };
      this.accounts.set(id, a);
    }
    return a;
  }

  private emitStatus(account: string) {
    this.events.emit('status', { account, ...this.status(account) });
  }
}
