// The rights an agent can prove about its owner, and what merchants may require.
//
// Rights are short strings, attested by our verifier after an EU wallet presentation and then
// delegated to the agent on the Flex: `age_over_18`, `nationality:FR`. They reveal one fact each,
// never who the person is. One attestation carries all of a person's rights as a comma-joined
// string, because its EIP-712 type has a single `claim` field of at most 32 bytes.
import { CLAIM_AGE_OVER_18 } from './eip712.js';
import { MAX_CLAIM_BYTES } from './credentials.js';

export const nationalityClaim = (countryCode: string) => {
  if (!/^[a-zA-Z]{2}$/.test(countryCode)) throw new Error(`not an ISO 3166-1 alpha-2 code: ${countryCode}`);
  return `nationality:${countryCode.toUpperCase()}`;
};

export function joinClaims(claims: string[]): string {
  const packed = [...new Set(claims)].sort().join(',');
  if (new TextEncoder().encode(packed).length > MAX_CLAIM_BYTES) {
    throw new Error(`these rights do not fit in one ${MAX_CLAIM_BYTES}-byte attestation: ${packed}`);
  }
  return packed;
}

export const attestedClaims = (packed: string) => packed.split(',').filter(Boolean);

const nationalities = (claims: string[]) =>
  claims.filter((c) => c.startsWith('nationality:')).map((c) => c.slice('nationality:'.length));

/**
 * Whether the rights `claims` meet a merchant's requirement:
 *   `age_over_18` · `nationality_not:US,RU` · `nationality_in:FR,DE`
 * Anything else, or a nationality requirement with no nationality right, is not met.
 */
export function satisfies(requirement: string, claims: string[]): boolean {
  if (requirement === CLAIM_AGE_OVER_18) return claims.includes(CLAIM_AGE_OVER_18);
  const [kind, list] = requirement.split(':', 2);
  const codes = (list ?? '').split(',').filter(Boolean);
  const held = nationalities(claims);
  if (held.length === 0 || codes.length === 0) return false;
  if (kind === 'nationality_not') return held.every((n) => !codes.includes(n));
  if (kind === 'nationality_in') return held.some((n) => codes.includes(n));
  return false;
}

export function describeRequirement(requirement: string): string {
  if (requirement === CLAIM_AGE_OVER_18) return '18 or older';
  const [kind, list] = requirement.split(':', 2);
  if (kind === 'nationality_not') return `not a ${(list ?? '').split(',').join('/')} national`;
  if (kind === 'nationality_in') return `a national of ${(list ?? '').split(',').join(', ')}`;
  return requirement;
}
