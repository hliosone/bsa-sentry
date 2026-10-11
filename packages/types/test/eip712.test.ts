// EIP-712 contract tests.
//
// Two independent paths must agree, and both must match the frozen fixture:
//   1. viem's hashTypedData, fed our exported domains + type definitions
//   2. a manual keccak encoder written here, mirroring exactly what the device does in Rust
// The fixture freezes the digests, so reordering a field or renaming a type breaks the build.
import { describe, expect, it } from 'vitest';
import { concatHex, hashTypedData, keccak256, pad, stringToHex, toHex, type Hex } from 'viem';
import {
  EIP712_TYPES, TYPE_STRINGS, paymentDomain, sentryDomain, verifierDomain,
  USDC_DOMAIN_NAME, USDC_DOMAIN_VERSION, SENTRY_DOMAIN_NAME, VERIFIER_DOMAIN_NAME,
} from '../src/index.js';
import fixtures from '../fixtures/eip712.json' with { type: 'json' };

/** 32-byte ABI word for a numeric or address value, exactly as the device left-pads. */
const word = (v: bigint | number | Hex): Hex =>
  typeof v === 'string' ? pad(v, { size: 32 }) : pad(toHex(v), { size: 32 });

const hashString = (s: string): Hex => keccak256(stringToHex(s));

/** keccak256 of the concatenated element hashes — EIP-712 encoding of string[]. */
const hashStringArray = (xs: readonly string[]): Hex => keccak256(concatHex(xs.map(hashString)));

/** EIP712Domain separator. Omits verifyingContract when the domain has none. */
function domainSeparator(d: { name: string; version: string; chainId: number; verifyingContract?: Hex }): Hex {
  const hasContract = d.verifyingContract !== undefined;
  const typeString = hasContract
    ? 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
    : 'EIP712Domain(string name,string version,uint256 chainId)';
  const parts: Hex[] = [hashString(typeString), hashString(d.name), hashString(d.version), word(d.chainId)];
  if (hasContract) parts.push(word(d.verifyingContract!));
  return keccak256(concatHex(parts));
}

/** Encodes one field the way the device does: strings and string[] are hashed, everything else is a word. */
function encodeField(type: string, value: unknown): Hex {
  if (type === 'string') return hashString(value as string);
  if (type === 'string[]') return hashStringArray(value as string[]);
  if (type === 'bytes32') return value as Hex;
  if (type === 'address') return word(value as Hex);
  if (type.startsWith('uint')) return word(BigInt(value as string | number | bigint));
  throw new Error(`unsupported EIP-712 field type: ${type}`);
}

function structHash(typeString: string, fields: readonly { name: string; type: string }[], message: Record<string, unknown>): Hex {
  return keccak256(concatHex([hashString(typeString), ...fields.map((f) => encodeField(f.type, message[f.name]))]));
}

/** Full EIP-712 digest, computed by hand. This is the algorithm device-app/core implements. */
function manualDigest(domain: Parameters<typeof domainSeparator>[0], typeString: string,
                      fields: readonly { name: string; type: string }[], message: Record<string, unknown>): Hex {
  return keccak256(concatHex(['0x1901', domainSeparator(domain), structHash(typeString, fields, message)]));
}

const cases = [
  { name: 'payment', primaryType: 'TransferWithAuthorization' as const, domainOf: (f: any) => paymentDomain(f.domain.chainId, f.domain.verifyingContract) },
  { name: 'login', primaryType: 'Login' as const, domainOf: (f: any) => sentryDomain(f.domain.chainId) },
  { name: 'bind', primaryType: 'Bind' as const, domainOf: (f: any) => sentryDomain(f.domain.chainId) },
  { name: 'delegation', primaryType: 'AgentDelegation' as const, domainOf: (f: any) => sentryDomain(f.domain.chainId) },
  { name: 'ageAttestation', primaryType: 'AgeAttestation' as const, domainOf: (f: any) => verifierDomain(f.domain.chainId) },
];

describe('EIP-712 golden vectors', () => {
  for (const c of cases) {
    describe(c.name, () => {
      const f = (fixtures as any)[c.name];

      it('has a fixture', () => {
        expect(f, `fixtures/eip712.json is missing "${c.name}"`).toBeDefined();
        expect(f.digest).toMatch(/^0x[0-9a-f]{64}$/);
      });

      it('our exported domain matches the fixture domain', () => {
        expect(c.domainOf(f)).toEqual(f.domain);
      });

      it('viem.hashTypedData reproduces the frozen digest', () => {
        const digest = hashTypedData({
          domain: f.domain,
          types: { [c.primaryType]: EIP712_TYPES[c.primaryType] },
          primaryType: c.primaryType,
          message: f.message,
        });
        expect(digest).toBe(f.digest);
      });

      it('the manual keccak encoder (what Rust does) reproduces the frozen digest', () => {
        expect(manualDigest(f.domain, TYPE_STRINGS[c.primaryType], EIP712_TYPES[c.primaryType], f.message)).toBe(f.digest);
      });

      it('the frozen domainSeparator and structHash match', () => {
        expect(domainSeparator(f.domain)).toBe(f.domainSeparator);
        expect(structHash(TYPE_STRINGS[c.primaryType], EIP712_TYPES[c.primaryType], f.message)).toBe(f.structHash);
      });

      it('the fixture records the canonical type string', () => {
        expect(f.typeString).toBe(TYPE_STRINGS[c.primaryType]);
      });
    });
  }
});

describe('EIP-712 domains', () => {
  it('USDC payment domain is name=USDC version=2 with the token as verifyingContract', () => {
    const d = paymentDomain(5042002, '0x3600000000000000000000000000000000000000');
    expect(d).toEqual({ name: 'USDC', version: '2', chainId: 5042002, verifyingContract: '0x3600000000000000000000000000000000000000' });
    expect(USDC_DOMAIN_NAME).toBe('USDC');
    expect(USDC_DOMAIN_VERSION).toBe('2');
  });

  it('the BSA Sentry and BSA Verifier domains have no verifyingContract', () => {
    expect(sentryDomain(5042002)).toEqual({ name: SENTRY_DOMAIN_NAME, version: '1', chainId: 5042002 });
    expect(verifierDomain(5042002)).toEqual({ name: VERIFIER_DOMAIN_NAME, version: '1', chainId: 5042002 });
    expect(SENTRY_DOMAIN_NAME).toBe('BSA Sentry');
    expect(VERIFIER_DOMAIN_NAME).toBe('BSA Verifier');
  });

  it('a payment and a Login on the same chain have different separators (domain separation)', () => {
    expect(domainSeparator(paymentDomain(5042002, '0x3600000000000000000000000000000000000000')))
      .not.toBe(domainSeparator(sentryDomain(5042002)));
    expect(domainSeparator(sentryDomain(5042002))).not.toBe(domainSeparator(verifierDomain(5042002)));
  });

  it('the same message on a different chain gives a different digest (replay across chains)', () => {
    const msg = { origin: 'https://bsa-sentry.ch', nonce: pad('0x01', { size: 32 }), issuedAt: 1760000000n, expiresAt: 1760000300n };
    const onArc = hashTypedData({ domain: sentryDomain(5042002), types: { Login: EIP712_TYPES.Login }, primaryType: 'Login', message: msg });
    const onBase = hashTypedData({ domain: sentryDomain(84532), types: { Login: EIP712_TYPES.Login }, primaryType: 'Login', message: msg });
    expect(onArc).not.toBe(onBase);
  });
});

describe('type strings are the canonical EIP-712 encodeType form', () => {
  it('match the field definitions exactly', () => {
    for (const [name, fields] of Object.entries(EIP712_TYPES)) {
      const expected = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
      expect(TYPE_STRINGS[name as keyof typeof TYPE_STRINGS]).toBe(expected);
    }
  });

  it('are the exact strings the device has compiled in', () => {
    expect(TYPE_STRINGS.TransferWithAuthorization).toBe(
      'TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');
    expect(TYPE_STRINGS.Login).toBe('Login(string origin,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)');
    expect(TYPE_STRINGS.Bind).toBe('Bind(string verifier,bytes32 session,uint64 expiresAt)');
    expect(TYPE_STRINGS.AgentDelegation).toBe(
      'AgentDelegation(address agent,string agentName,bytes32 attestation,string[] claims,uint64 expiresAt,bytes32 nonce)');
    expect(TYPE_STRINGS.AgeAttestation).toBe(
      'AgeAttestation(address subject,string claim,uint64 issuedAt,uint64 expiresAt,bytes32 evidence)');
  });
});
