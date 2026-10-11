// All of the page's state in one hook: the Flex connection, the login, the bridge, the device
// state mirror and the live feed. Pages only render it and call its actions.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { decodeState, type Credentials, type DeviceState, type Policy } from '@bsa-sentry/types';
import { Bridge, type BridgeStatus } from './bridge/bridge.js';
import { api, relayUrl, type Config } from './api.js';
import { feedReducer, initialFeed, type FeedEvent } from './state/feed.js';
import { connectFlex, reconnectFlex, type FlexConnection } from './device/flex.js';
import type { FlowDeps } from './keyring/flows.js';
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

  const adopt = useCallback(async (s: AppSigner) => {
    setSigner(s);
    const [main, agent] = [await s.getAddress('main'), await s.getAddress('agent')];
    setAddresses({ main, agent });
    setDevice(await s.getState().catch(() => null));
  }, []);

  /** "Connecter le Flex". In a dev build, `?fakeDevice=1` swaps in the Playwright stand-in. */
  const connect = useCallback(() => run('Choisis ton Flex dans la fenêtre de Chrome…', async () => {
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('fakeDevice')) {
      const { fakeSigner } = await import('./device/fake.js');
      const fake = fakeSigner();
      (window as any).__bsaFake = fake;
      await adopt(fake as unknown as AppSigner);
      return;
    }
    const c = await connectFlex();
    conn.current = c;
    c.onLost(() => { setSigner(null); setBridgeStatus((b) => ({ ...b, flex: 'disconnected' })); });
    await adopt(c.signer as unknown as AppSigner);
  }), [run, adopt]);

  // A Flex this browser already approved reconnects on its own after a reload or app switch.
  useEffect(() => {
    if (signer) return;
    return reconnectFlex((c) => {
      conn.current = c;
      c.onLost(() => setSigner(null));
      void adopt(c.signer as unknown as AppSigner);
    });
  }, [signer, adopt]);

  /** "Se connecter avec Ledger": the Flex signs a Login with 0xMAIN. */
  const login = useCallback(() => run('Vérifie le site affiché sur ton Flex, puis maintiens pour signer…', async () => {
    if (!signer || !addresses.main) throw new Error('Connecte d\'abord ton Flex');
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
    if (!signer) throw new Error('Connecte d\'abord ton Flex');
    return bridge.current ? bridge.current.exclusive(() => fn(signer)) : fn(signer);
  }, [signer]);

  const refreshDevice = useCallback(async () => {
    if (!signer) return;
    setDevice(await onDevice((s) => s.getState()));
    await bridge.current?.refresh();
  }, [signer, onDevice]);

  const setRules = useCallback((p: Policy) => run('Vérifie chaque règle et chaque adresse EN ENTIER sur ton Flex, puis maintiens pour approuver…', async () => {
    await onDevice((s) => s.setPolicy(p));
    await refreshDevice();
  }), [run, onDevice, refreshDevice]);

  const clearRules = useCallback(() => run('Confirme le blocage de l\'agent sur ton Flex…', async () => {
    await onDevice((s) => s.clearPolicy());
    await refreshDevice();
  }), [run, onDevice, refreshDevice]);

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
      return fn(new FakeKeyRing(addresses.main ?? 'dev'));
    }
    const c = conn.current;
    if (!c) throw new Error('Connecte d\'abord ton Flex');
    if (!(await c.switchApp('Ledger Sync'))) await ask("Sur ton Flex, quitte BSA Sentry et ouvre l'app Ledger Sync.", 'Ledger Sync est ouvert');
    await c.disconnect();
    conn.current = null;
    const { openLedgerKeyRing } = await import('./keyring/ledger.js');
    const kr = await openLedgerKeyRing((on) => setBusy(on ? 'Confirme sur ton Flex (Ledger Sync)…' : 'Chiffrement…'));
    try {
      return await fn(kr);
    } finally {
      await kr.close().catch(() => undefined);
      await ask("Sur ton Flex, quitte Ledger Sync et rouvre l'app BSA Sentry.", 'BSA Sentry est rouvert');
      // The browser already allowed this Flex: reconnect without the picker.
      await new Promise<void>((resolve) => {
        const stop = reconnectFlex((nc) => { conn.current = nc; void adopt(nc.signer as unknown as AppSigner).then(() => { stop(); resolve(); }); });
      });
    }
  }, [addresses.main, adopt]);

  const flowDeps = useCallback((onStage: FlowDeps['onStage']): FlowDeps => ({
    readDevice: async () => {
      const st = await onDevice((s) => s.getState());
      const credentials = (await onDevice((s) => s.getCredentials())) as Credentials | null;
      return { policy: st.policy.active ? st.policy : null, credentials };
    },
    putVault: async (ciphertext) => {
      const r = await fetch(vaultUrl(), { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ciphertext }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'sauvegarde refusée');
      setHasBackup(true);
    },
    getVault: async () => {
      const r = await fetch(vaultUrl(), { credentials: 'same-origin' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('lecture de la sauvegarde refusée');
      return (await r.json()).ciphertext;
    },
    withKeyRing,
    restore: (policy, credentials) => onDevice((s) => s.restore(policy, credentials)),
    onStage,
  }), [onDevice, withKeyRing, addresses.main]);

  return {
    config, account, signer, addresses, bridgeStatus, device, feed, busy, error, hasBackup, prompt,
    connect, login, setRules, clearRules, refreshDevice, logout, onDevice, run, flowDeps,
    dismissBanner: () => dispatch({ type: 'dismiss' }),
    clearError: () => setError(null),
  };
}

export type Bsa = ReturnType<typeof useBsa>;
