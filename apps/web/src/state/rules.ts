// The rules form. Everything the device would reject is rejected here first, with a message
// the user can act on; the device then shows the result for a final review anyway.
import { getAddress } from 'viem';
import type { Policy } from '@bsa-sentry/types';

export type RulesForm = {
  autoMax: string;
  hardMax: string;
  budget: string;
  maxCount: string;
  payees: { label: string; address: string }[];
};

/** The demo values from the spec: 5 automatic, 50 ceiling, 20 budget, 10 payments. */
export const defaultRules = (payees: { label: string; address: string }[]): RulesForm => ({
  autoMax: '5', hardMax: '50', budget: '20', maxCount: '10', payees,
});

/** "4,5" or "4.5" USDC -> 4500000 base units. No floating point anywhere. */
export function parseUsdc(input: string): bigint | null {
  const s = input.trim().replace(',', '.');
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * EIP-55: all-lowercase and all-uppercase hex are accepted as-is; mixed case must carry a
 * valid checksum, because a wrong one usually means a typo in a pasted address.
 */
export function isValidAddress(a: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const hex = a.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  try {
    return getAddress(a) === a;
  } catch {
    return false;
  }
}

export function validateRules(form: RulesForm, ctx: { chainId: bigint; token: `0x${string}` }):
  | { ok: true; policy: Policy }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const amount = (field: keyof RulesForm, label: string) => {
    const v = parseUsdc(form[field] as string);
    if (v === null) errors[field] = `${label}: an amount in USDC, at most 6 decimals`;
    else if (v === 0n) errors[field] = `${label}: must be greater than 0`;
    return v ?? 0n;
  };
  const autoMax = amount('autoMax', 'Automatic limit');
  const hardMax = amount('hardMax', 'Hard limit');
  const budget = amount('budget', 'Budget');
  if (!errors.autoMax && !errors.hardMax && autoMax > hardMax) {
    errors.autoMax = 'The automatic limit cannot be above the hard limit';
  }

  const maxCount = Number(form.maxCount.trim());
  if (!/^\d+$/.test(form.maxCount.trim()) || maxCount < 1 || maxCount > 65535) {
    errors.maxCount = 'Number of payments: a whole number between 1 and 65535';
  }

  if (form.payees.length > 8) errors.payees = 'The Flex keeps at most 8 merchants';
  const seen = new Set<string>();
  form.payees.forEach((p, i) => {
    const label = p.label.trim();
    if (!label) errors[`payees.${i}.label`] = 'A name is required: the Flex shows it';
    else if (bytes(label) > 16) errors[`payees.${i}.label`] = 'Name too long: 16 bytes at most (accented letters count double)';
    if (!isValidAddress(p.address)) errors[`payees.${i}.address`] = 'Invalid address (0x followed by 40 hex characters)';
    else if (seen.has(p.address.toLowerCase())) errors[`payees.${i}.address`] = 'This merchant is already in the list';
    else seen.add(p.address.toLowerCase());
  });

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    policy: {
      active: true,
      chainId: ctx.chainId,
      token: ctx.token.toLowerCase() as `0x${string}`,
      autoMax,
      hardMax,
      budget,
      maxCount,
      payees: form.payees.map((p) => ({ address: p.address.toLowerCase() as `0x${string}`, label: p.label.trim() })),
    },
  };
}
