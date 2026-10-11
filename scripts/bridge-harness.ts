// The browser bridge, run headless in Node against Speculos.
//
// It is the SAME `Bridge` module the website runs in Chrome; only the transport (Speculos
// HTTP instead of WebHID) and the socket (the `ws` client instead of the browser's) differ.
// That is what lets `pnpm e2e` exercise server -> relay -> bridge -> device -> Arc with real
// on-chain settlement and no hardware.
//
//   pnpm harness --url ws://localhost:8787/relay [--cookie 'bsa_session=...']
import WebSocket from 'ws';
import { SentrySigner } from '@bsa-sentry/sentry-signer';
import { SpeculosTransport } from '@bsa-sentry/sentry-signer/transports/speculos';
import { Bridge, type BridgeStatus, type SocketLike } from '@bsa-sentry/web/bridge';

export type HarnessOptions = {
  url: string;
  /** The session cookie a browser would send automatically. */
  cookie?: string;
  speculosApi?: string;
  onStatus?: (s: BridgeStatus) => void;
  log?: (message: string, detail?: unknown) => void;
};

export function startBridgeHarness(opts: HarnessOptions) {
  const signer = new SentrySigner(new SpeculosTransport(opts.speculosApi));
  const bridge = new Bridge({
    signer,
    connect: () =>
      new WebSocket(opts.url, { headers: opts.cookie ? { cookie: opts.cookie } : {} }) as unknown as SocketLike,
    reconnectDelayMs: 500,
    onStatus: opts.onStatus,
    log: opts.log,
  });
  bridge.start();
  return { bridge, signer, stop: () => bridge.stop() };
}

// CLI entry: keep a bridge attached until Ctrl-C.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const url = arg('url') ?? process.env.RELAY_URL ?? 'ws://localhost:8787/relay';
  const { stop } = startBridgeHarness({
    url,
    cookie: arg('cookie') ?? process.env.BRIDGE_COOKIE,
    onStatus: (s) => console.log(`[bridge] socket=${s.socket} flex=${s.flex} session=${s.session ? 'on' : 'off'}`),
    log: (m, d) => console.log(`[bridge] ${m}`, d instanceof Error ? d.message : d ?? ''),
  });
  console.log(`[bridge] attached to ${url}, relaying to Speculos. Ctrl-C to stop.`);
  process.on('SIGINT', () => { stop(); process.exit(0); });
}
