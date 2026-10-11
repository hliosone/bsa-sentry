// WebSocket relay message schemas.
//
// These are the only validation between the server and the bridge tab, so every object is
// `.strict()`: an unknown key is an error, not something to pass along. Numbers travel as
// decimal strings because JSON cannot hold a u256 without losing precision, and the device
// parses fixed-width big-endian words.
import { z } from 'zod';
import { BRIDGE_REASONS } from './errors.js';

/** Lower-cased on parse so the device's byte comparison and ours always agree. */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte hex address')
  .transform((s) => s.toLowerCase() as `0x${string}`);

const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 32 bytes of hex')
  .transform((s) => s.toLowerCase() as `0x${string}`);

const hexBlob = z.string().regex(/^0x([0-9a-fA-F]{2})+$/, 'expected a hex blob')
  .transform((s) => s.toLowerCase() as `0x${string}`);

/** A decimal string, bounded, parsed to bigint. Rejects numbers, hex and separators. */
const decimalUint = (bits: 64 | 256) => {
  const max = 2n ** BigInt(bits) - 1n;
  return z.string().regex(/^(0|[1-9][0-9]*)$/, 'expected a decimal string')
    .transform((s) => BigInt(s))
    .refine((v) => v <= max, { message: `does not fit in a uint${bits}` });
};

const utf8Bytes = (max: number) =>
  z.string().refine((s) => new TextEncoder().encode(s).length <= max, { message: `must be at most ${max} UTF-8 bytes` });

export const PaymentFields = z.object({
  chainId: decimalUint(64),
  token: address,
  to: address,
  value: decimalUint(256),
  validAfter: decimalUint(256),
  validBefore: decimalUint(256),
  nonce: bytes32,
}).strict();

export type PaymentFields = z.infer<typeof PaymentFields>;

export const SignPaymentRequest = z.object({
  id: z.string().min(1),
  type: z.literal('sign_payment'),
  fields: PaymentFields,
  /** What the agent claims the payee is. Shown on the device as unverified; 24 bytes max. */
  hint: utf8Bytes(24).optional(),
  wantCredentials: z.boolean(),
}).strict();

export const GetStateRequest = z.object({
  id: z.string().min(1),
  type: z.literal('get_state'),
}).strict();

/** Asks the tab to start the Key Ring restore flow (MCP `sentry_restore`). The user drives it. */
export const StartRestoreRequest = z.object({
  id: z.string().min(1),
  type: z.literal('start_restore'),
}).strict();

export const ServerToTab = z.discriminatedUnion('type', [SignPaymentRequest, GetStateRequest, StartRestoreRequest]);
export type ServerToTab = z.infer<typeof ServerToTab>;

const Signature = z.object({
  /** secp256k1 recovery id in Ethereum form. The device returns 27 or 28, nothing else. */
  v: z.union([z.literal(27), z.literal(28)]),
  r: bytes32,
  s: bytes32,
}).strict();

const Credentials = z.object({
  attestation: hexBlob,
  attestationSig: hexBlob,
  delegation: hexBlob,
  delegationSig: hexBlob,
}).strict();

export const RelayOk = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  signature: Signature,
  credentials: Credentials.optional(),
}).strict();

export const RelayErr = z.object({
  id: z.string().min(1),
  ok: z.literal(false),
  reason: z.enum(BRIDGE_REASONS),
}).strict();

export const StatusMessage = z.object({
  type: z.literal('status'),
  flex: z.enum(['connected', 'locked', 'app_closed', 'disconnected']),
  session: z.boolean(),
  /** The GET_STATE blob, hex-encoded. Decoded with decodeState(). */
  state: hexBlob.optional(),
  /**
   * The Flex's 0xAGENT, the `from` of every authorization. Reported by the tab that holds the
   * device; the socket is already bound to the account. A wrong value cannot redirect funds:
   * the device fills `from` with its own key, so a mismatch just fails ecrecover.
   */
  agent: address.optional(),
}).strict();

export const TabToServer = z.union([RelayOk, RelayErr, StatusMessage]);
export type TabToServer = z.infer<typeof TabToServer>;
export type RelayOk = z.infer<typeof RelayOk>;
export type RelayErr = z.infer<typeof RelayErr>;
export type StatusMessage = z.infer<typeof StatusMessage>;

const parseWith = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, direction: string, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`invalid ${direction} relay message: ${JSON.stringify((r.error as z.ZodError).issues)}`);
  return r.data as T;
};

export const parseServerToTab = (v: unknown): ServerToTab => parseWith(ServerToTab, 'server->tab', v);
export const parseTabToServer = (v: unknown): TabToServer => parseWith(TabToServer, 'tab->server', v);
