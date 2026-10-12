// All of the page's state in one hook: the Flex connection, the login, the bridge, the device
// state mirror and the live feed. Pages only render it and call its actions.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { decodeState, type Credentials, type DeviceState, type Policy } from '@bsa-sentry/types';
import { Bridge, type BridgeStatus } from './bridge/bridge.js';
import { api, relayUrl, type Config } from './api.js';
import { feedReducer, initialFeed, type FeedEvent } from './state/feed.js';
import { connectFlex, reconnectFlex, type FlexConnection } from './device/flex.js';
import type { FlowDeps } from './keyring/flows.js';
import type { Hex } from 'viem';
import { parseUsdc } from './state/rules.js';
import type { KeyRing } from './keyring/keyring.js';

/** The slice of sentry-signer the website uses; the dev-only fake device implements it too. */
export type AppSigner = {
  getAddress(a: 'main' | 'agent'): Promise<`0x${string}`>;
  getState(): Promise<DeviceState>;
  probe(): Promise<{ flex: BridgeStatus['flex']; session: boolean; state?: DeviceState }>;
  setPolicy(p: Policy): Promise<void>;
  clearPolicy(): Promise<void>;
  signLogin(m: { chainId: bigint; origin: string; nonce: `0x${string}`; issuedAt: bigint; expiresAt: bigint }): Promise<`0x${string}`>;
  pay(...args: any[]): Promise<any>;
  getCredentialsWire?(): Promise<any>;
  [k: string]: any;
};

const unhex = (h: string) => Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => parseInt(x, 16));

export function useBsa() {
  const [config, setConfig] = useState<Config | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [signer, setSigner] = useState<AppSigner | null>(null);
  const [addresses, setAddresses] = useState<{ main?: string; agent?: string }>({});
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ socket: 'closed', flex: 'disconnected', session: false });
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [feed, dispatch] = useReducer(feedReducer, initialFeed);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = useRef<Bridge | null>(null);
  const conn = useRef<FlexConnection | null>(null);
  /** The signer of the current DMK session: an app switch replaces it mid-flow. */
  const live = useRef<AppSigner | null>(null);
  /** While the Key Ring runs, BSA Sentry is closed on purpose and `withKeyRing` owns the reconnect. */
  const keyRingActive = useRef(false);
  const [hasBackup, setHasBackup] = useState(false);
  /** A step only the user can do on the device, with the button that confirms it. */
  const [prompt, setPrompt] = useState<{ text: string; button: string; resolve: () => void } | null>(null);
  const ask = (text: string, button: string) => new Promise<void>((resolve) => setPrompt({ text, button, resolve: () => { setPrompt(null); resolve(); } }));

  useEffect(() => {
    void api.config().then(setConfig).catch((e) => setError(String(e)));
    void api.me().then((m) => setAccount(m?.account ?? null));
  }, []);

  /** Wraps an action: shows what to do on the device, surfaces any error in French. */
  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  /** Tracks a connection. Losing it during the Key Ring is expected, so it is ignored there. */
  const watch = useCallback((c: FlexConnection) => {
    conn.current = c;
    c.onLost(() => {
      if (keyRingActive.current) return;
      live.current = null;
      setSigner(null);
      setBridgeStatus((b) => ({ ...b, flex: 'disconnected' }));
    });
  }, []);

  const adopt = useCallback(async (s: AppSigner) => {
    live.current = s;
    setSigner(s);
    const [main, agent] = [await s.getAddress('main'), await s.getAddress('agent')];
    setAddresses({ main, agent });
    setDevice(await s.getState().catch(() => null));
  }, []);

  /** "Connect the Flex". In a dev build, `?fakeDevice=1` swaps in the Playwright stand-in. */
  const connect = useCallback(() => run('Pick your Flex in the Chrome window…', async () => {
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('fakeDevice')) {
      const { fakeSigner } = await import('./device/fake.js');
      const fake = fakeSigner();
      (window as any).__bsaFake = fake;
      await adopt(fake as unknown as AppSigner);
      return;
    }
    const c = await connectFlex();
    watch(c);
    await adopt(c.signer as unknown as AppSigner);
  }), [run, adopt, watch]);

  // A Flex this browser already approved reconnects on its own after a reload or app switch.
  useEffect(() => {
    if (signer || keyRingActive.current) return;
    return reconnectFlex((c) => {
      watch(c);
      void adopt(c.signer as unknown as AppSigner);
    });
  }, [signer, adopt, watch]);

  /** "Log in with Ledger": the Flex signs a Login with 0xMAIN. */
  const login = useCallback(() => run('Check the website shown on your Flex, then hold to sign…', async () => {
    if (!signer || !addresses.main) throw new Error('Connect your Flex first');
    const c = await api.challenge();
    const signature = await signer.signLogin({
      chainId: BigInt(c.chainId), origin: c.origin, nonce: c.nonce, issuedAt: BigInt(c.issuedAt), expiresAt: BigInt(c.expiresAt),
    });
    const r = await api.login(addresses.main, c.nonce, signature);
    setAccount(r.account);
    const back = new URLSearchParams(location.search).get('returnTo');
    // Only ever bounce back to our own OAuth consent page.
    if (back && new URL(back, location.href).origin === location.origin) location.href = back;
  }), [run, signer, addresses.main]);

  // The bridge: alive whenever the user is logged in and the Flex is connected.
  useEffect(() => {
    if (!account || !signer) return;
    const b = new Bridge({
      signer: signer as any,
      connect: () => new WebSocket(relayUrl()) as any,
      onStatus: setBridgeStatus,
      onRestoreRequested: () => { location.hash = '#/restore'; },
    });
    bridge.current = b;
    b.start();
    return () => { b.stop(); bridge.current = null; };
  }, [account, signer]);

  // The live feed, for this account only.
  useEffect(() => {
    if (!account) return;
    const es = new EventSource('/events');
    const on = (type: string, fn: (d: any) => void) => es.addEventListener(type, (e) => fn(JSON.parse((e as MessageEvent).data)));
    on('status', (d) => { if (d.state) try { setDevice(decodeState(unhex(d.state))); } catch { /* stale */ } });
    on('request', (d) => dispatch({ type: 'request', id: d.id, at: Date.now(), message: d.message } as FeedEvent));
    on('answer', (d) => dispatch({ type: 'answer', id: d.id, answer: d.answer } as FeedEvent));
    on('payment', (d) => dispatch({ type: 'payment', ...d } as FeedEvent));
    return () => es.close();
  }, [account]);

  /** A device command from the page, queued behind any payment the bridge is handling. */
  const onDevice = useCallback(<T,>(fn: (s: AppSigner) => Promise<T>) => {
    // The latest session, not the one this callback was created with: a restore writes to the
    // device right after the Key Ring round trip replaced the DMK session.
    const s = live.current;
    if (!s) throw new Error('Connect your Flex first');
    return bridge.current ? bridge.current.exclusive(() => fn(s)) : fn(s);
  }, []);

  const refreshDevice = useCallback(async () => {
    if (!signer) return;
    setDevice(await onDevice((s) => s.getState()));
    await bridge.current?.refresh();
  }, [signer, onDevice]);

  const setRules = useCallback((p: Policy) => run('Check every rule and every FULL address on your Flex, then hold to approve…', async () => {
    await onDevice((s) => s.setPolicy(p));
    await refreshDevice();
  }), [run, onDevice, refreshDevice]);

  const clearRules = useCallback(() => run('Confirm blocking the agent on your Flex…', async () => {
    await onDevice((s) => s.clearPolicy());
    await refreshDevice();
  }), [run, onDevice, refreshDevice]);

  /** 0xMAIN -> the agent, signed on the Flex (which picks the recipient itself), submitted by the server. */
  const topUp = useCallback((amount: string) => run('Check the top-up on your Flex (amount, from your main account, to your agent), then hold to sign…', async () => {
    const value = parseUsdc(amount);
    if (!value || !config) throw new Error('Enter an amount in USDC');
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('')}` as Hex;
    const signature = await onDevice((s) => s.topUp({ chainId: BigInt(config.chainId), token: config.usdc as Hex, value, validAfter: 0n, validBefore, nonce }));
    const r = await fetch('/topup', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: value.toString(), validAfter: '0', validBefore: validBefore.toString(), nonce, signature }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? 'the top-up was refused');
    await refreshDevice();
    return body as { txHash: string; amount: string };
  }), [run, onDevice, config, refreshDevice]);

  const logout = useCallback(async () => { await api.logout(); setAccount(null); }, []);

  // ---------------------------------------------------------------- Key Ring backup / restore

  const vaultUrl = () => `/vault/${addresses.main}`;
  useEffect(() => {
    if (!account || !addresses.main) return;
    void fetch(`/vault/${addresses.main}`, { credentials: 'same-origin' }).then((r) => setHasBackup(r.ok));
  }, [account, addresses.main]);

  /**
   * The Key Ring needs the Ledger Sync app, and its transport must not share the device with
   * the DMK. So: switch apps (automatically if the device lets the DMK do it, otherwise ask),
   * release the DMK, run the Key Ring, then come back to BSA Sentry and reconnect.
   */
  const withKeyRing = useCallback(async <T,>(fn: (kr: KeyRing) => Promise<T>): Promise<T> => {
    if (import.meta.env.DEV && (window as any).__bsaFake) {
      const { FakeKeyRing } = await import('./keyring/fake.js');
      try {
        return await fn(new FakeKeyRing(addresses.main ?? 'dev'));
      } finally {
        // As on a real Flex, the round trip through Ledger Sync ends with a new DMK session.
        const next = (window as any).__bsaFake.reconnect();
        (window as any).__bsaFake = next;
        await adopt(next as unknown as AppSigner);
      }
    }
    const c = conn.current;
    if (!c) throw new Error('Connect your Flex first');
    keyRingActive.current = true;
    try {
      if (!(await c.switchApp('Ledger Sync'))) await ask('On your Flex, quit BSA Sentry and open the Ledger Sync app.', 'Ledger Sync is open');
      await c.disconnect();
      conn.current = null;
      const { openLedgerKeyRing } = await import('./keyring/ledger.js');
      const kr = await openLedgerKeyRing((on) => setBusy(on ? 'Confirm on your Flex (Ledger Sync)…' : 'Encrypting…'));
      try {
        return await fn(kr);
      } finally {
        await kr.close().catch(() => undefined);
      }
    } finally {
      // The browser already allowed this Flex: reconnect without the picker. If BSA Sentry is not
      // open yet, its first command fails: ask again rather than hang.
      for (let back = false; !back; ) {
        await ask('On your Flex, quit Ledger Sync and reopen the BSA Sentry app.', 'BSA Sentry is open again');
        back = await new Promise<boolean>((resolve) => {
          const stop = reconnectFlex((nc) => {
            stop();
            adopt(nc.signer as unknown as AppSigner).then(
              () => { watch(nc); resolve(true); },
              () => { void nc.disconnect().catch(() => undefined).then(() => resolve(false)); },
            );
          });
        });
      }
      keyRingActive.current = false;
    }
  }, [addresses.main, adopt, watch]);

  const flowDeps = useCallback((onStage: FlowDeps['onStage']): FlowDeps => ({
    readDevice: async () => {
      const st = await onDevice((s) => s.getState());
      const credentials = (await onDevice((s) => s.getCredentials())) as Credentials | null;
      return { policy: st.policy.active ? st.policy : null, credentials };
    },
    putVault: async (ciphertext) => {
      const r = await fetch(vaultUrl(), { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ciphertext }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'backup refused');
      setHasBackup(true);
    },
    getVault: async () => {
      const r = await fetch(vaultUrl(), { credentials: 'same-origin' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('reading the backup was refused');
      return (await r.json()).ciphertext;
    },
    withKeyRing,
    restore: (policy, credentials) => onDevice((s) => s.restore(policy, credentials)),
    onStage,
  }), [onDevice, withKeyRing, addresses.main]);

  return {
    config, account, signer, addresses, bridgeStatus, device, feed, busy, error, hasBackup, prompt,
    connect, login, setRules, clearRules, refreshDevice, logout, onDevice, run, flowDeps, topUp,
    dismissBanner: () => dispatch({ type: 'dismiss' }),
    clearError: () => setError(null),
  };
}

export type Bsa = ReturnType<typeof useBsa>;
