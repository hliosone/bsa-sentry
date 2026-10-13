import { describe, expect, it } from 'vitest';
import { attestedClaims, joinClaims, nationalityClaim, satisfies, describeRequirement } from '../src/index.js';

describe('identity claims', () => {
  it('names a nationality right by its ISO country code', () => {
    expect(nationalityClaim('fr')).toBe('nationality:FR');
    expect(() => nationalityClaim('France')).toThrow();
  });

  it('packs several rights into the one attestation claim string (32 bytes max), and back', () => {
    const packed = joinClaims(['nationality:FR', 'age_over_18']);
    expect(packed).toBe('age_over_18,nationality:FR');
    expect(attestedClaims(packed)).toEqual(['age_over_18', 'nationality:FR']);
    expect(() => joinClaims(['age_over_18', 'nationality:FR', 'nationality:DE'])).toThrow(/32/);
  });

  it('checks a merchant requirement against the rights the agent holds', () => {
    const fr = ['age_over_18', 'nationality:FR'];
    expect(satisfies('age_over_18', fr)).toBe(true);
    expect(satisfies('age_over_18', ['nationality:FR'])).toBe(false);
    expect(satisfies('nationality_not:US', fr)).toBe(true);
    expect(satisfies('nationality_not:US', ['nationality:US'])).toBe(false);
    // No nationality right at all: the requirement is not met (fail closed).
    expect(satisfies('nationality_not:US', ['age_over_18'])).toBe(false);
    expect(satisfies('nationality_in:FR,DE', fr)).toBe(true);
    expect(satisfies('nationality_in:DE,IT', fr)).toBe(false);
    expect(satisfies('something_else', fr)).toBe(false);
  });

  it('describes a requirement in words for the user', () => {
    expect(describeRequirement('age_over_18')).toBe('18 or older');
    expect(describeRequirement('nationality_not:US')).toBe('not a US national');
  });
});
