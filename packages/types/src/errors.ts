// Status words and reason codes. Rust matches on these exact byte values, so they are
// pinned by tests on both sides and must never be renumbered.

export const SW = {
  OK: 0x9000,
  /** Refusal. For PAY the device appends one REFUSAL_REASON byte. */
  DENY: 0x6985,
  /** Chunked payload would exceed the device reassembly buffer. */
  PAYLOAD_TOO_LARGE: 0xb004,
  /** A "next" chunk arrived without a "first". */
  NEXT_WITHOUT_FIRST: 0xb00b,
  /** OS-level: the Flex is locked (auto-lock). Not ours. */
  DEVICE_LOCKED: 0x5515,
  /** OS-level: a blocking screen is up and refused the command. */
  CMD_NOT_ACCEPTED: 0x6901,
  WRONG_LENGTH: 0x6700,
  /** App closed / wrong app open. */
  INS_NOT_SUPPORTED: 0x6d00,
  CLA_NOT_SUPPORTED: 0x6e00,
} as const;

/** The byte the device appends after 0x6985. 0 is reserved so a zeroed buffer is never valid. */
export const REFUSAL_REASON = {
  NO_POLICY: 1,
  NO_SESSION: 2,
  WRONG_CHAIN_OR_TOKEN: 3,
  INVALID_AMOUNT: 4,
  OVER_HARD_MAX: 5,
  USER_REJECTED: 6,
  TIMEOUT: 7,
} as const;

export type RefusalReason = keyof typeof REFUSAL_REASON;

export const REFUSAL_REASON_BY_BYTE: Record<number, RefusalReason> = Object.fromEntries(
  Object.entries(REFUSAL_REASON).map(([name, byte]) => [byte, name as RefusalReason]),
);

/** Why decide() chose an orange screen. Shown to the user; never returned after 0x6985. */
export const ORANGE_REASON = {
  UNKNOWN_PAYEE: 1,
  OVER_AUTO_MAX: 2,
  BUDGET_EXCEEDED: 3,
  COUNT_EXCEEDED: 4,
} as const;

export type OrangeReason = keyof typeof ORANGE_REASON;

/**
 * What the bridge tab may report to the server: the device reasons plus transport failures.
 * Spelled out as a literal tuple (not spread from REFUSAL_REASON) so zod and TypeScript see
 * a fixed, non-empty union; a test checks it stays in step with REFUSAL_REASON.
 */
export const BRIDGE_REASONS = [
  'NO_POLICY', 'NO_SESSION', 'WRONG_CHAIN_OR_TOKEN', 'INVALID_AMOUNT', 'OVER_HARD_MAX',
  'USER_REJECTED', 'TIMEOUT', 'FLEX_LOCKED', 'APP_CLOSED', 'DISCONNECTED',
] as const;

export type BridgeReason = (typeof BRIDGE_REASONS)[number];

export const isRefusalReason = (s: string): s is RefusalReason => s in REFUSAL_REASON;

export const refusalReasonName = (byte: number): RefusalReason | undefined => REFUSAL_REASON_BY_BYTE[byte];

/**
 * Reads the reason out of a 0x6985 response.
 * A bare 0x6985 with no reason byte means the user pressed Refuse on a screen that predates
 * the reason convention (and the SDK's own Deny path), so it maps to USER_REJECTED.
 */
export function parseRefusal(sw: number, data: Uint8Array): RefusalReason {
  if (sw !== SW.DENY) throw new Error(`parseRefusal expects 0x6985, got 0x${sw.toString(16)}`);
  if (data.length === 0) return 'USER_REJECTED';
  const name = refusalReasonName(data[0]!);
  if (!name) throw new Error(`unknown refusal reason byte 0x${data[0]!.toString(16)}`);
  return name;
}

/** An error carrying the status word the device answered with. */
export class ApduError extends Error {
  constructor(readonly sw: number, message: string) {
    super(`${message} (0x${sw.toString(16).padStart(4, '0')})`);
    this.name = 'ApduError';
  }
}
