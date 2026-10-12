// A software stand-in for the Flex, for the website's Playwright tests ONLY.
//
// Loaded only in a Vite dev build with `?fakeDevice=1`: production builds drop the import
// entirely (import.meta.env.DEV is a compile-time false there). It signs with throwaway keys
// and approves everything a real user would tap through, but applies the same hard ceiling
// so the dashboard's refusal path can be exercised too.
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';
import {
  EIP712_TYPES, encodeCredentials, paymentDomain, sentryDomain, splitCredentials, splitSignature, toWireSignature,
  type Credentials, type DeviceState, type Policy,
} from '@bsa-sentry/types';
import { DeviceRefusedError } from '@bsa-sentry/sentry-signer';

const main = privateKeyToAccount(keccak256(toHex('bsa-sentry fake device main')));
const agent = privateKeyToAccount(keccak256(toHex('bsa-sentry fake device agent')));

export function fakeSigner() {
  let policy: Policy = { active: false, chainId: 0n, token: `0x${'00'.repeat(20)}`, autoMax: 0n, hardMax: 0n, budget: 0n, maxCount: 0, payees: [] };
  let spent = 0n;
  let count = 0;
  let last: DeviceState['lastPayment'] = null;
  let session = false;
  let creds: Credentials | null = null;
  const state = (): DeviceState => ({ sessionArmed: session, hasCredentials: !!creds, spent, count, lastPayment: last, policy });

  const device = {
    /** Test hook standing in for the switch on the device. */
    armSession(on = true) { session = on; },
    getAddress: async (a: 'main' | 'agent') => (a === 'main' ? main.address : agent.address).toLowerCase() as `0x${string}`,
    getState: async () => state(),
    probe: async () => ({ flex: 'connected' as const, session, state: state() }),
    setPolicy: async (p: Policy) => { policy = p; spent = 0n; count = 0; last = null; },
    clearPolicy: async () => { policy = { ...policy, active: false, payees: [] }; spent = 0n; count = 0; },
    signLogin: async (m: { chainId: bigint; origin: string; nonce: `0x${string}`; issuedAt: bigint; expiresAt: bigint }) =>
      toWireSignature(await main.signTypedData({
        domain: sentryDomain(Number(m.chainId)), types: { Login: EIP712_TYPES.Login }, primaryType: 'Login',
        message: { origin: m.origin, nonce: m.nonce, issuedAt: m.issuedAt, expiresAt: m.expiresAt },
      })),
    pay: async (f: { chainId: bigint; token: `0x${string}`; to: `0x${string}`; value: bigint; validAfter: bigint; validBefore: bigint; nonce: `0x${string}` }) => {
      if (!policy.active) throw new DeviceRefusedError('NO_POLICY');
      if (!session) throw new DeviceRefusedError('NO_SESSION');
      if (f.value > policy.hardMax) throw new DeviceRefusedError('OVER_HARD_MAX');
      const sig = await agent.signTypedData({
        domain: paymentDomain(Number(f.chainId), f.token),
        types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
        primaryType: 'TransferWithAuthorization',
        message: { from: agent.address, to: f.to, value: f.value, validAfter: f.validAfter, validBefore: f.validBefore, nonce: f.nonce },
      });
      spent += f.value; count += 1;
      last = { label: policy.payees.find((p) => p.address === f.to)?.label ?? 'Merchant', value: f.value };
      return splitSignature(toWireSignature(sig));
    },
    signBind: async (m: { chainId: bigint; verifier: string; session: `0x${string}`; expiresAt: bigint }) =>
      toWireSignature(await main.signTypedData({
        domain: sentryDomain(Number(m.chainId)), types: { Bind: EIP712_TYPES.Bind }, primaryType: 'Bind',
        message: { verifier: m.verifier, session: m.session, expiresAt: m.expiresAt },
      })),
    topUp: async (m: { chainId: bigint; token: `0x${string}`; value: bigint; validAfter: bigint; validBefore: bigint; nonce: `0x${string}` }) =>
      toWireSignature(await main.signTypedData({
        domain: paymentDomain(Number(m.chainId), m.token),
        types: { TransferWithAuthorization: EIP712_TYPES.TransferWithAuthorization },
        primaryType: 'TransferWithAuthorization',
        message: { from: main.address, to: agent.address, value: m.value, validAfter: m.validAfter, validBefore: m.validBefore, nonce: m.nonce },
      })),
    signDelegation: async (m: { chainId: bigint; agent: `0x${string}`; agentName: string; attestation: `0x${string}`; claims: string[]; expiresAt: bigint; nonce: `0x${string}` }) => {
      const { chainId, ...message } = m;
      return toWireSignature(await main.signTypedData({
        domain: sentryDomain(Number(chainId)), types: { AgentDelegation: EIP712_TYPES.AgentDelegation }, primaryType: 'AgentDelegation', message,
      }));
    },
    storeCredentials: async (c: Credentials) => { encodeCredentials(c); creds = c; },
    getCredentials: async () => creds,
    getCredentialsWire: async () => (creds ? splitCredentials(creds) : null),
    restore: async (p: Policy, c: Credentials | null) => { policy = p; spent = 0n; count = 0; last = null; if (c) creds = c; },
    /** Test hook: what a reinstall of the app does to the device. */
    wipe() { policy = { ...policy, active: false, payees: [] }; creds = null; spent = 0n; count = 0; last = null; session = false; },
  };

  // Like the DMK after an app switch: the old session object is dead and a new one takes over,
  // so a page that keeps using a stale signer fails here exactly as it would on a real Flex.
  const hooks = new Set(['armSession', 'wipe']);
  type Handle = typeof device & { reconnect(): Handle };
  const connect = (): Handle => {
    let open = true;
    const handle = {} as Record<string, unknown>;
    for (const [k, v] of Object.entries(device)) {
      handle[k] = hooks.has(k) ? v : (...a: unknown[]) => {
        if (!open) return Promise.reject(new Error('fake Flex: this session was closed by an app switch'));
        return (v as (...a: unknown[]) => unknown)(...a);
      };
    }
    handle.reconnect = () => { open = false; return connect(); };
    return handle as Handle;
  };
  return connect();
}
