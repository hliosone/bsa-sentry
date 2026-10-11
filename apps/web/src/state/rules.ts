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
    if (v === null) errors[field] = `${label} : un montant en USDC, 6 décimales au plus`;
    else if (v === 0n) errors[field] = `${label} : doit être supérieur à 0`;
    return v ?? 0n;
  };
  const autoMax = amount('autoMax', 'Limite automatique');
  const hardMax = amount('hardMax', 'Plafond absolu');
  const budget = amount('budget', 'Budget');
  if (!errors.autoMax && !errors.hardMax && autoMax > hardMax) {
    errors.autoMax = 'La limite automatique ne peut pas dépasser le plafond absolu';
  }

  const maxCount = Number(form.maxCount.trim());
  if (!/^\d+$/.test(form.maxCount.trim()) || maxCount < 1 || maxCount > 65535) {
    errors.maxCount = 'Nombre de paiements : un entier entre 1 et 65535';
  }

  if (form.payees.length > 8) errors.payees = 'Le Flex garde 8 marchands au plus';
  const seen = new Set<string>();
  form.payees.forEach((p, i) => {
    const label = p.label.trim();
    if (!label) errors[`payees.${i}.label`] = 'Un nom est requis : le Flex l\'affiche';
    else if (bytes(label) > 16) errors[`payees.${i}.label`] = 'Nom trop long : 16 octets au plus (les accents comptent double)';
    if (!isValidAddress(p.address)) errors[`payees.${i}.address`] = 'Adresse invalide (0x suivi de 40 caractères hexadécimaux)';
    else if (seen.has(p.address.toLowerCase())) errors[`payees.${i}.address`] = 'Ce marchand est déjà dans la liste';
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
