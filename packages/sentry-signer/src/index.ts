// The only thing in BSA Sentry that talks to the Flex.
//
// Transport-agnostic on purpose: the same code runs in the browser over WebHID (DMK), in
// Node against Speculos, and in the smoke script against real hardware. A bug fixed here is
// fixed everywhere, and the Speculos tests exercise the same command encoding the browser
// will use.
//
// Two rules the device imposes on every caller:
//   - ONE command at a time. The device cannot interleave, and a half-sent chunked transfer
//     desynchronises the protocol in a way that is very hard to recover from.
//   - A timeout of at least 120 s. The orange screen alone can hold for 60 s, and a host
//     that gives up early reads the late reply as the answer to its *next* command.
import {
  CLA, INS, MAX_APDU_DATA, REFUSAL_REASON_BY_BYTE, SW, decodeCredentials, decodeState,
  encodeBindPayload, encodeChunks, encodeCredentials, encodeDelegationPayload,
  encodeLoginPayload, encodePolicy, splitCredentials, splitSignature,
  type BridgeReason, type CredentialParts, type Credentials, type DeviceState, type Policy,
  type RefusalReason,
} from '@bsa-sentry/types';
import type { Hex } from 'viem';

/** Anything that can exchange one APDU for one response (data followed by SW1 SW2). */
export interface Transport {
  send(apdu: Uint8Array): Promise<Uint8Array>;
}

export class TransportError extends Error {
  readonly bridgeReason: BridgeReason = 'DISCONNECTED';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TransportError';
  }
}

/** The device said no, and told us why. */
export class DeviceRefusedError extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`refused by your Flex: ${reason}`);
    this.name = 'DeviceRefusedError';
  }
  get bridgeReason(): BridgeReason {
    return this.reason;
  }
}

export class DeviceLockedError extends Error {
  readonly bridgeReason: BridgeReason = 'FLEX_LOCKED';
  constructor() {
    super('your Flex is locked: unlock it and try again');
    this.name = 'DeviceLockedError';
  }
}

export class AppClosedError extends Error {
  readonly bridgeReason: BridgeReason = 'APP_CLOSED';
  constructor() {
    super('the BSA Sentry app is not open on your Flex');
    this.name = 'AppClosedError';
  }
}

/** An unexpected status word. Kept distinct so a real protocol bug is never silently a refusal. */
export class DeviceError extends Error {
  constructor(readonly sw: number, message: string) {
    super(`${message} (0x${sw.toString(16).padStart(4, '0')})`);
    this.name = 'DeviceError';
  }
}

export type Account = 'main' | 'agent';

export type PaymentFields = {
  chainId: bigint;
  token: Hex;
  to: Hex;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export type DeviceStatus = {
  flex: 'connected' | 'locked' | 'app_closed' | 'disconnected';
  session: boolean;
  state?: DeviceState;
};

/** The device's own cap on the agent hint. Checked here so a bad hint never reaches it. */
const MAX_HINT_BYTES = 24;
const DEFAULT_TIMEOUT_MS = 125_000;
const CREDENTIALS_READ_CHUNK = 200;

const utf8 = new TextEncoder();

const beBytes = (v: bigint, size: number, name: string): Uint8Array => {
  if (v < 0n || v >= 1n << BigInt(size * 8)) throw new Error(`${name} does not fit in ${size} bytes`);
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) out[i] = Number((v >> BigInt((size - 1 - i) * 8)) & 0xffn);
  return out;
};

const fixedHex = (value: Hex, size: number, name: string): Uint8Array => {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${size * 2}}$`).test(value)) {
    throw new Error(`${name} must be ${size} bytes of hex, got ${value}`);
  }
  return Uint8Array.from(value.slice(2).match(/../g)!, (b) => parseInt(b, 16));
};

const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

export class SentrySigner {
  /** Serialises every command: the device handles exactly one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  readonly timeoutMs: number;

  constructor(private readonly transport: Transport, opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ------------------------------------------------------------------ commands

  async getAddress(account: Account, opts: { display?: boolean } = {}): Promise<Hex> {
    const data = await this.command(INS.GET_ADDRESS, account === 'agent' ? 1 : 0, opts.display ? 1 : 0);
    if (data.length !== 20) throw new DeviceError(SW.OK, `expected a 20 bytes address, got ${data.length}`);
    return toHex(data);
  }

  async getState(): Promise<DeviceState> {
    return decodeState(await this.command(INS.GET_STATE));
  }

  /** Needs an on-device review and a tap; resolves once the user approves. */
  async setPolicy(policy: Policy): Promise<void> {
    await this.chunked(INS.SET_POLICY, encodePolicy(policy));
  }

  /** The kill switch. Needs an on-device review and a tap. */
  async clearPolicy(): Promise<void> {
    await this.command(INS.CLEAR_POLICY);
  }

  /**
   * Asks for a payment signature. Silent when the policy allows it, otherwise the device
   * shows the orange screen and this resolves when the user chooses (or after 60 s).
   */
  async pay(fields: PaymentFields, opts: { hint?: string } = {}): Promise<{ v: 27 | 28; r: Hex; s: Hex }> {
    const hint = utf8.encode(opts.hint ?? '');
    if (hint.length > MAX_HINT_BYTES) {
      throw new Error(`hint is ${hint.length} bytes, the device accepts at most ${MAX_HINT_BYTES}`);
    }
    const payload = concat([
      beBytes(fields.chainId, 8, 'chainId'),
      fixedHex(fields.token, 20, 'token'),
      fixedHex(fields.to, 20, 'to'),
      beBytes(fields.value, 32, 'value'),
      beBytes(fields.validAfter, 32, 'validAfter'),
      beBytes(fields.validBefore, 32, 'validBefore'),
      fixedHex(fields.nonce, 32, 'nonce'),
      hint,
    ]);
    const data = await this.command(INS.PAY, 0, 0, payload);
    if (data.length !== 65) throw new DeviceError(SW.OK, `expected a 65 bytes signature, got ${data.length}`);
    return splitSignature(toHex(data));
  }

  /** `Login`, signed by 0xMAIN after a tap. Returns the wire signature (v | r | s). */
  async signLogin(m: { chainId: bigint; origin: string; nonce: Hex; issuedAt: bigint; expiresAt: bigint }): Promise<Hex> {
    return toHex(await this.command(INS.SIGN_LOGIN, 0, 0, encodeLoginPayload(m)));
  }

  /** `Bind`, signed by 0xMAIN after a tap. */
  async signBind(m: { chainId: bigint; verifier: string; session: Hex; expiresAt: bigint }): Promise<Hex> {
    return toHex(await this.command(INS.SIGN_BIND, 0, 0, encodeBindPayload(m)));
  }

  /** `AgentDelegation`, signed by 0xMAIN after a tap. */
  async signDelegation(m: {
    chainId: bigint; agent: Hex; agentName: string; attestation: Hex;
    claims: string[]; expiresAt: bigint; nonce: Hex;
  }): Promise<Hex> {
    return toHex(await this.chunked(INS.SIGN_DELEGATION, encodeDelegationPayload(m)));
  }

  async storeCredentials(c: Credentials): Promise<void> {
    await this.chunked(INS.STORE_CREDENTIALS, encodeCredentials(c));
  }

  /** `null` when the device holds nothing, which is the website's cue to offer a restore. */
  async getCredentials(): Promise<Credentials | null> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let chunk = 0; chunk < 16; chunk++) {
      const data = await this.command(INS.GET_CREDENTIALS, chunk, 0);
      if (data.length < 2) throw new DeviceError(SW.OK, 'truncated GET_CREDENTIALS reply');
      total = (data[0]! << 8) | data[1]!;
      if (total === 0) return null;
      parts.push(data.subarray(2));
      if (parts.reduce((n, p) => n + p.length, 0) >= total) break;
    }
    const joined = concat(parts).subarray(0, total);
    if (joined.length !== total) throw new DeviceError(SW.OK, `credentials truncated: ${joined.length}/${total}`);
    return decodeCredentials(joined);
  }

  /** The credentials in the relay message's four-field form, or `null` if none are stored. */
  async getCredentialsWire(): Promise<CredentialParts | null> {
    const c = await this.getCredentials();
    return c ? splitCredentials(c) : null;
  }

  /** Restores a policy, and optionally credentials, from a backup. Needs a full review. */
  async restore(policy: Policy, credentials?: Credentials | null): Promise<void> {
    const payload = credentials
      ? concat([encodePolicy(policy), encodeCredentials(credentials)])
      : encodePolicy(policy);
    await this.chunked(INS.RESTORE, payload);
  }

  /**
   * One cheap round trip that never throws, for the bridge status bar.
   * Everything the user might need to fix maps to a distinct state.
   */
  async probe(): Promise<DeviceStatus> {
    try {
      const state = await this.getState();
      return { flex: 'connected', session: state.sessionArmed, state };
    } catch (e) {
      if (e instanceof DeviceLockedError) return { flex: 'locked', session: false };
      if (e instanceof AppClosedError) return { flex: 'app_closed', session: false };
      return { flex: 'disconnected', session: false };
    }
  }

  // ------------------------------------------------------------------ plumbing

  /** Runs `fn` once the device is free, and keeps the queue usable if it throws. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Swallow the rejection on the chain itself; the caller still sees it through `run`.
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private command(ins: number, p1 = 0, p2 = 0, data = new Uint8Array()): Promise<Uint8Array> {
    return this.enqueue(() => this.exchange(Uint8Array.from([CLA, ins, p1, p2, data.length, ...data])));
  }

  /**
   * Sends a payload in 250-byte chunks. Only the last reply carries data: the device
   * acknowledges the earlier ones empty.
   */
  private chunked(ins: number, payload: Uint8Array): Promise<Uint8Array> {
    const apdus = encodeChunks(ins, payload);
    if (payload.length > apdus.length * MAX_APDU_DATA) throw new Error('chunking bug');
    return this.enqueue(async () => {
      let last = new Uint8Array();
      for (const apdu of apdus) last = await this.exchange(apdu);
      return last;
    });
  }

  private async exchange(apdu: Uint8Array): Promise<Uint8Array> {
    let raw: Uint8Array;
    try {
      raw = await this.withTimeout(this.transport.send(apdu));
    } catch (e) {
      if (e instanceof TransportError) throw e;
      throw new TransportError(`the Flex did not answer: ${(e as Error).message}`, e);
    }
    if (raw.length < 2) throw new TransportError(`short APDU reply (${raw.length} bytes)`);
    const sw = (raw[raw.length - 2]! << 8) | raw[raw.length - 1]!;
    const data = raw.subarray(0, raw.length - 2);
    if (sw === SW.OK) return data;
    throw this.toError(sw, data);
  }

  private toError(sw: number, data: Uint8Array): Error {
    switch (sw) {
      case SW.DENY: {
        // The device appends one reason byte, except on the SDK's own deny path.
        const reason = data.length > 0 ? REFUSAL_REASON_BY_BYTE[data[0]!] : 'USER_REJECTED';
        if (!reason) return new DeviceError(sw, `refused with an unknown reason byte 0x${data[0]!.toString(16)}`);
        return new DeviceRefusedError(reason);
      }
      case SW.DEVICE_LOCKED:
        return new DeviceLockedError();
      case SW.INS_NOT_SUPPORTED:
      case SW.CLA_NOT_SUPPORTED:
        return new AppClosedError();
      case SW.CMD_NOT_ACCEPTED:
        return new DeviceError(sw, 'the Flex is showing a screen and refused the command; finish or dismiss it');
      case SW.PAYLOAD_TOO_LARGE:
        return new DeviceError(sw, 'the payload is larger than the device can reassemble');
      case SW.NEXT_WITHOUT_FIRST:
        return new DeviceError(sw, 'the device lost track of a chunked transfer; retry from the first chunk');
      case SW.WRONG_LENGTH:
        return new DeviceError(sw, 'the device rejected the payload length');
      default:
        return new DeviceError(sw, 'unexpected status word');
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new TransportError(`the Flex did not answer within ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
}
