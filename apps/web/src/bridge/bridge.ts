// The bridge: the one Chrome tab the user keeps open.
//
// It relays between our server (WebSocket) and the Flex (WebHID, through sentry-signer).
// The same module runs in Node against Speculos (`scripts/bridge-harness.ts`), which is how
// the whole server -> relay -> bridge -> device -> Arc chain is tested without hardware.
//
// Two rules it must never break:
//   - **Everything is driven by socket messages, never by a timer.** Chrome throttles timers
//     in a hidden tab to roughly one tick a minute, but WebSocket delivery and WebHID keep
//     working. Polling would make a backgrounded tab look broken.
//   - **Every request gets exactly one answer.** The server waits up to 120 s per request;
//     silence stalls the agent with no explanation.
import {
  encodeState, parseServerToTab, type BridgeReason, type ServerToTab, type TabToServer,
} from '@bsa-sentry/types';
import {
  AppClosedError, DeviceLockedError, DeviceRefusedError, type SentrySigner,
} from '@bsa-sentry/sentry-signer';

/** The slice of WebSocket the bridge uses, so it can be faked in tests and reused in Node. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', handler: (e: any) => void): void;
}

/** The credential blobs, hex-encoded, exactly as the relay message carries them. */
export type CredentialsWire = {
  attestation: `0x${string}`;
  attestationSig: `0x${string}`;
  delegation: `0x${string}`;
  delegationSig: `0x${string}`;
};

/** What the bridge needs. A signer, a way to make a socket, and somewhere to log. */
export type BridgeOptions = {
  signer: SentrySigner & { getCredentialsWire?: () => Promise<CredentialsWire | null> };
  connect: () => SocketLike;
  reconnectDelayMs?: number;
  onStatus?: (status: BridgeStatus) => void;
  /** The server asked for a restore (MCP sentry_restore); the page shows the restore flow. */
  onRestoreRequested?: () => void;
  log?: (message: string, detail?: unknown) => void;
};

export type BridgeStatus = {
  socket: 'connecting' | 'open' | 'closed';
  flex: 'connected' | 'locked' | 'app_closed' | 'disconnected';
  session: boolean;
};

const hex = (b: Uint8Array): `0x${string}` =>
  `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

export class Bridge {
  private socket: SocketLike | null = null;
  private running = false;
  /** Serialises device work: the Flex handles one command at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private credentials: CredentialsWire | null = null;
  private agentAddress: `0x${string}` | null = null;
  private credentialsRead = false;
  private status: BridgeStatus = { socket: 'closed', flex: 'disconnected', session: false };

  constructor(private readonly opts: BridgeOptions) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.open();
  }

  stop() {
    this.running = false;
    this.socket?.close();
    this.socket = null;
    this.setStatus({ socket: 'closed' });
  }

  getStatus(): BridgeStatus {
    return { ...this.status };
  }

  /**
   * Re-reads the device and reports it. Only ever called from a user action (a button), never
   * from a timer: the user just changed something on the Flex and wants the page to see it.
   */
  refresh(): Promise<void> {
    return new Promise((resolve) => this.run(async () => { await this.reportStatus(); resolve(); }));
  }

  /** Runs a device command from the page in the same queue as relay requests. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => this.run(async () => {
      try { resolve(await fn()); } catch (e) { reject(e); }
      await this.reportStatus().catch(() => undefined);
    }));
  }

  // ------------------------------------------------------------------ socket

  private open() {
    if (!this.running) return;
    this.setStatus({ socket: 'connecting' });
    const socket = this.opts.connect();
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.setStatus({ socket: 'open' });
      // Announce ourselves immediately: the dashboard shows this, and the server needs to
      // know a tab is attached before it will accept an agent request.
      this.run(() => this.reportStatus());
    });

    socket.addEventListener('message', (e: { data: unknown }) => {
      this.onMessage(typeof e.data === 'string' ? e.data : String(e.data));
    });

    socket.addEventListener('close', () => {
      this.setStatus({ socket: 'closed' });
      if (!this.running) return;
      // A dropped socket is normal (sleep, network blip, server restart). Reconnect, but
      // only ever from this event: no polling loop.
      setTimeout(() => this.open(), this.opts.reconnectDelayMs ?? 1000);
    });

    socket.addEventListener('error', (e: unknown) => this.opts.log?.('socket error', e));
  }

  private send(message: TabToServer) {
    try {
      this.socket?.send(JSON.stringify(message, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (e) {
      this.opts.log?.('could not send', e);
    }
  }

  private onMessage(raw: string) {
    let parsed: ServerToTab;
    try {
      parsed = parseServerToTab(JSON.parse(raw));
    } catch (e) {
      // A malformed request must never reach the device. There is no id we can trust, so
      // there is nothing to answer either; log it and carry on.
      this.opts.log?.('ignored an invalid relay message', e);
      return;
    }
    this.run(() => this.handle(parsed));
  }

  /** Queues device work so two requests can never interleave on the device. */
  private run(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn, fn).catch((e) => this.opts.log?.('bridge task failed', e));
  }

  // ------------------------------------------------------------------ requests

  private async handle(msg: ServerToTab): Promise<void> {
    switch (msg.type) {
      case 'get_state':
        await this.reportStatus();
        return;
      case 'sign_payment':
        await this.signPayment(msg);
        return;
      case 'start_restore':
        // Restoring needs Ledger Sync and the user's taps, so the page takes over.
        this.opts.onRestoreRequested?.();
        return;
    }
  }

  private async signPayment(msg: Extract<ServerToTab, { type: 'sign_payment' }>): Promise<void> {
    try {
      const signature = await this.opts.signer.pay(msg.fields, msg.hint ? { hint: msg.hint } : {});
      const credentials = msg.wantCredentials ? await this.readCredentials() : null;
      this.send(credentials ? { id: msg.id, ok: true, signature, credentials } : { id: msg.id, ok: true, signature });
    } catch (e) {
      this.send({ id: msg.id, ok: false, reason: toBridgeReason(e) });
      this.opts.log?.('payment refused or failed', e);
    } finally {
      // The device state moved (or the Flex changed state); keep the dashboard honest.
      await this.reportStatus().catch(() => undefined);
    }
  }

  /**
   * Credentials are read from the Flex once and kept **in memory only** — never in
   * localStorage, never on disk. A reload re-reads them from the device.
   */
  private async readCredentials(): Promise<CredentialsWire | null> {
    if (this.credentialsRead) return this.credentials;
    try {
      const read = this.opts.signer.getCredentialsWire;
      this.credentials = read ? await read.call(this.opts.signer) : null;
    } catch (e) {
      this.opts.log?.('could not read credentials', e);
      this.credentials = null;
    }
    this.credentialsRead = true;
    return this.credentials;
  }

  private async reportStatus(): Promise<void> {
    const probe = await this.opts.signer.probe();
    this.setStatus({ flex: probe.flex, session: probe.session });
    // The server needs 0xAGENT as the `from` of every authorization. Read it once from the
    // device, only while the app answers; it never changes for a given seed.
    if (!this.agentAddress && probe.flex === 'connected') {
      try {
        this.agentAddress = await this.opts.signer.getAddress('agent');
      } catch (e) {
        this.opts.log?.('could not read the agent address', e);
      }
    }
    this.send({
      type: 'status',
      flex: probe.flex,
      session: probe.session,
      ...(probe.state ? { state: hex(encodeState(probe.state)) } : {}),
      ...(this.agentAddress ? { agent: this.agentAddress } : {}),
    });
  }

  private setStatus(patch: Partial<BridgeStatus>) {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus?.(this.getStatus());
  }
}

/** Maps any failure onto the one word the server and the agent understand. */
export function toBridgeReason(e: unknown): BridgeReason {
  if (e instanceof DeviceRefusedError) return e.reason;
  if (e instanceof DeviceLockedError) return 'FLEX_LOCKED';
  if (e instanceof AppClosedError) return 'APP_CLOSED';
  // Anything else is, from the server's point of view, a tab that could not deliver.
  return 'DISCONNECTED';
}
