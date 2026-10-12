// The three things 0xMAIN signs (Login, Bind, AgentDelegation) and the credential store.
//
// Security invariant 5: 0xMAIN signs only these three, always with a tap. Every signature
// is recovered with viem and must come back as 0xMAIN — not 0xAGENT, not anything else.
// Security invariant 6 (device half): the device refuses to store a credential bundle it
// cannot tie to its own 0xMAIN and its own 0xAGENT.
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CLAIM_AGE_OVER_18, EIP712_TYPES, SW, decodeCredentials, encodeChunks, encodeCredentials,
  encodeBindPayload, encodeDelegationPayload, encodeLoginPayload, sentryDomain, verifierDomain,
  REFUSAL_REASON, toViemSignature, toWireSignature, type Credentials,
} from '@bsa-sentry/types';
import { INS, apdu, approveReview, hex, rejectReview, screenshot, send, unhex, waitForText } from './client.js';

config({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });

const ARC = 5042002n;
const main = () => (process.env.SPECULOS_MAIN_ADDRESS ?? '').toLowerCase();
const agentAddr = () => (process.env.SPECULOS_AGENT_ADDRESS ?? '').toLowerCase() as `0x${string}`;

/** Device signatures are v | r | s; viem wants r | s | v. */
const toViemSig = (sig: Uint8Array) => {
  expect(sig).toHaveLength(65);
  expect([27, 28]).toContain(sig[0]);
  return `0x${hex(sig.subarray(1, 33))}${hex(sig.subarray(33, 65))}${sig[0]!.toString(16)}` as `0x${string}`;
};

const b32 = (h: string) => `0x${h.repeat(32)}` as `0x${string}`;

describe('SIGN_LOGIN', () => {
  const msg = {
    origin: 'https://bsa-sentry.ch',
    nonce: b32('a1'),
    issuedAt: 1_760_000_000n,
    expiresAt: 1_760_000_300n,
  };

  it('shows the origin, and 0xMAIN signs it after a tap', async () => {
    const payload = encodeLoginPayload({ chainId: ARC, ...msg });
    const pending = apdu(Uint8Array.from([0xe0, INS.SIGN_LOGIN, 0, 0, payload.length, ...payload]));
    await waitForText(/Log in/i);
    await screenshot('08-sign-login');
    await approveReview();
    const r = await pending;
    expect(r.sw).toBe(SW.OK);

    const signer = await recoverTypedDataAddress({
      domain: sentryDomain(Number(ARC)),
      types: { Login: EIP712_TYPES.Login },
      primaryType: 'Login',
      message: msg,
      signature: toViemSig(r.data),
    });
    expect(signer.toLowerCase(), 'Login must be signed by 0xMAIN, never 0xAGENT').toBe(main());
    expect(signer.toLowerCase()).not.toBe(agentAddr());
  });

  it('returns nothing when the user rejects', async () => {
    const payload = encodeLoginPayload({ chainId: ARC, ...msg, nonce: b32('a2') });
    const pending = apdu(Uint8Array.from([0xe0, INS.SIGN_LOGIN, 0, 0, payload.length, ...payload]));
    await waitForText(/Log in/i);
    await rejectReview();
    const r = await pending;
    expect(r.sw).toBe(SW.DENY);
    expect(r.data[0]).toBe(REFUSAL_REASON.USER_REJECTED);
  });

  it('rejects a truncated payload', async () => {
    const short = new Uint8Array(12);
    expect((await apdu(Uint8Array.from([0xe0, INS.SIGN_LOGIN, 0, 0, short.length, ...short]))).sw).toBe(0x6700);
  });
});

describe('SIGN_BIND', () => {
  it('shows the verifier and binds the session with 0xMAIN', async () => {
    const msg = { verifier: 'https://verifier-backend.eudiw.dev', session: b32('b1'), expiresAt: 1_760_000_900n };
    const payload = encodeBindPayload({ chainId: ARC, ...msg });
    const pending = apdu(Uint8Array.from([0xe0, INS.SIGN_BIND, 0, 0, payload.length, ...payload]));
    await waitForText(/Link/i);
    await screenshot('09-sign-bind');
    await approveReview();
    const r = await pending;
    expect(r.sw).toBe(SW.OK);

    const signer = await recoverTypedDataAddress({
      domain: sentryDomain(Number(ARC)),
      types: { Bind: EIP712_TYPES.Bind },
      primaryType: 'Bind',
      message: msg,
      signature: toViemSig(r.data),
    });
    expect(signer.toLowerCase()).toBe(main());
  });
});

/** Builds the delegation the device will be asked to sign, and the matching attestation. */
function identityFixtures() {
  const issuer = privateKeyToAccount(process.env.ISSUER_PRIVATE_KEY as `0x${string}`);
  const attestation = {
    subject: main() as `0x${string}`,
    claim: CLAIM_AGE_OVER_18,
    issuedAt: 1_760_000_000n,
    expiresAt: 1_762_592_000n,
    evidence: b32('e1'),
  };
  // The delegation commits to the attestation by hash, which is what the facilitator checks.
  const attestationHash = hashTypedData({
    domain: verifierDomain(Number(ARC)),
    types: { AgeAttestation: EIP712_TYPES.AgeAttestation },
    primaryType: 'AgeAttestation',
    message: attestation,
  });
  const delegation = {
    agent: agentAddr(),
    agentName: 'Claude',
    attestation: attestationHash,
    claims: [CLAIM_AGE_OVER_18],
    expiresAt: 1_762_592_000n,
    nonce: b32('d1'),
  };
  return { issuer, attestation, delegation };
}

describe('SIGN_DELEGATION and the credential store', () => {
  let bundle: Credentials;

  beforeAll(async () => {
    const { issuer, attestation, delegation } = identityFixtures();

    // 1. The device signs the delegation with 0xMAIN, after showing the agent address.
    const payload = encodeDelegationPayload({ chainId: ARC, ...delegation });
    const chunks = encodeChunks(INS.SIGN_DELEGATION, payload);
    let last: Awaited<ReturnType<typeof apdu>> | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      if (!isLast) {
        last = await apdu(chunks[i]!);
        continue;
      }
      const pending = apdu(chunks[i]!);
      await waitForText(/Authorize/i);
      await screenshot('10-sign-delegation');
      await approveReview();
      last = await pending;
    }
    expect(last!.sw).toBe(SW.OK);
    // The device returns v | r | s, which is exactly the wire order the bundle stores.
    const delegationSig = `0x${hex(last!.data)}` as `0x${string}`;

    // 2. Our issuer signs the attestation (the device never checks this one; the
    //    facilitator does, which is the point of invariant 6). viem returns r | s | v, so
    //    it has to be converted to the wire order before it goes into the bundle.
    const attestationSig = toWireSignature(
      await issuer.signTypedData({
        domain: verifierDomain(Number(ARC)),
        types: { AgeAttestation: EIP712_TYPES.AgeAttestation },
        primaryType: 'AgeAttestation',
        message: attestation,
      }),
    );

    bundle = { chainId: ARC, attestation, attestationSig, delegation, delegationSig };
  });

  it('signed the delegation with 0xMAIN and showed the agent address in full', async () => {
    const { delegation } = identityFixtures();
    const signer = await recoverTypedDataAddress({
      domain: sentryDomain(Number(ARC)),
      types: { AgentDelegation: EIP712_TYPES.AgentDelegation },
      primaryType: 'AgentDelegation',
      message: delegation,
      signature: toViemSignature(bundle.delegationSig as `0x${string}`),
    });
    expect(signer.toLowerCase()).toBe(main());
  });

  it('stores a bundle that belongs to this device, with no tap', async () => {
    const blob = encodeCredentials(bundle);
    const chunks = encodeChunks(INS.STORE_CREDENTIALS, blob);
    for (const c of chunks) expect((await apdu(c)).sw).toBe(SW.OK);

    // GET_STATE now reports credentials, which is what the dashboard shows.
    const { decodeState } = await import('@bsa-sentry/types');
    expect(decodeState((await send(INS.GET_STATE)).data).hasCredentials).toBe(true);
  });

  it('reads the bundle back byte for byte, in 200-byte chunks', async () => {
    const expected = encodeCredentials(bundle);
    const parts: Uint8Array[] = [];
    let total = -1;
    for (let chunk = 0; chunk < 10; chunk++) {
      const r = await send(INS.GET_CREDENTIALS, chunk, 0);
      expect(r.sw).toBe(SW.OK);
      total = (r.data[0]! << 8) | r.data[1]!;
      parts.push(r.data.subarray(2));
      if (parts.reduce((n, p) => n + p.length, 0) >= total) break;
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { joined.set(p.subarray(0, total - at), at); at += p.length; }
    expect(total).toBe(expected.length);
    expect(hex(joined)).toBe(hex(expected));
    // And it decodes back to the same structure.
    expect(decodeCredentials(joined).delegation.agent).toBe(agentAddr());
  });

  it('refuses a bundle whose delegation targets a different agent', async () => {
    const tampered: Credentials = {
      ...bundle,
      delegation: { ...bundle.delegation, agent: `0x${'77'.repeat(20)}` },
    };
    const chunks = encodeChunks(INS.STORE_CREDENTIALS, encodeCredentials(tampered));
    let last = { sw: 0, data: new Uint8Array() };
    for (const c of chunks) last = await apdu(c);
    expect(last.sw, 'a delegation for someone else must be refused').toBe(SW.DENY);
  });

  it('refuses a bundle whose delegation signature is not this device\'s 0xMAIN', async () => {
    const tampered: Credentials = { ...bundle, delegationSig: `0x1b${'cd'.repeat(64)}` };
    const chunks = encodeChunks(INS.STORE_CREDENTIALS, encodeCredentials(tampered));
    let last = { sw: 0, data: new Uint8Array() };
    for (const c of chunks) last = await apdu(c);
    expect(last.sw).toBe(SW.DENY);
  });

  it('refuses a bundle whose delegation fields were altered after signing', async () => {
    // Same signature, different claims: the digest no longer matches.
    const tampered: Credentials = {
      ...bundle,
      delegation: { ...bundle.delegation, claims: ['age_over_21'] },
    };
    const chunks = encodeChunks(INS.STORE_CREDENTIALS, encodeCredentials(tampered));
    let last = { sw: 0, data: new Uint8Array() };
    for (const c of chunks) last = await apdu(c);
    expect(last.sw).toBe(SW.DENY);
  });

  it('kept the original bundle through every rejected attempt', async () => {
    const r = await send(INS.GET_CREDENTIALS, 0, 0);
    const total = (r.data[0]! << 8) | r.data[1]!;
    expect(total).toBe(encodeCredentials(bundle).length);
  });
});

describe('GET_CREDENTIALS on a device with nothing stored', () => {
  it('reports a length of zero, which is how the website knows to offer a restore', async () => {
    const { restart } = await import('./client.js');
    restart(true);
    const r = await send(INS.GET_CREDENTIALS, 0, 0);
    expect(r.sw).toBe(SW.OK);
    expect((r.data[0]! << 8) | r.data[1]!).toBe(0);
    expect(r.data.length).toBe(2);
  });
});
