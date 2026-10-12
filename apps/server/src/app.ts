// Composes the BSA server: facilitator, relay, and the agent API.
// Auth, OAuth and MCP are mounted on top of this (M4); everything here is usable on its own,
// which is how the e2e scripts run the real stack in-process.
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import type { Hex } from 'viem';
import type { ChainConfig } from './chain.js';
import { chainDeps, facilitatorRouter } from './facilitator/routes.js';
import type { AgeVerdict } from './facilitator/facilitator.js';
import { Relay } from './relay/relay.js';
import { x402Fetch, type X402Result } from './agent/x402-client.js';
import { paymentEvent } from './agent/events.js';

export type ServerOptions = {
  chain: ChainConfig;
  facilitatorKey: Hex;
  /** Resolves the account a relay socket belongs to, or null to refuse it. */
  authenticateSocket(req: IncomingMessage): Promise<string | null> | string | null;
  /** Allowed Origin for the relay socket (the website). Unset only in tests. */
  webOrigin?: string;
  verifyAge?: (proof: unknown, payer: Hex) => Promise<AgeVerdict>;
  relayTimeoutMs?: number;
  log?: (m: string) => void;
  /** Lets M4 mount auth, OAuth and MCP routes before the server starts listening. */
  extend?: (app: express.Express, ctx: { relay: Relay; agent: Agent }) => void;
};

export type Agent = {
  fetch(account: string, req: { url: string; method?: string; body?: string }): Promise<X402Result>;
};

export function createServer(opts: ServerOptions) {
  const log = opts.log ?? (() => {});
  const relay = new Relay({ timeoutMs: opts.relayTimeoutMs });
  const deps = chainDeps(opts.chain, opts.facilitatorKey, opts.verifyAge ? { verifyAge: opts.verifyAge } : {});

  const agent: Agent = {
    fetch: async (account, req) => {
      const result = await x402Fetch(account, req, {
        fetch,
        relay,
        chainId: opts.chain.chainId,
        usdc: opts.chain.usdc,
        now: () => Math.floor(Date.now() / 1000),
        agentAddress: async (acct) => {
          const a = relay.status(acct).agent;
          if (!a) throw new Error('no BSA Sentry tab is attached for this account');
          return a;
        },
      });
      // The dashboard feed: the settlement (or why nothing was paid) after the device answered.
      const event = paymentEvent(account, req.url, result);
      if (event) relay.events.emit('payment', event);
      return result;
    },
  };

  const app = express();
  app.disable('x-powered-by');
  // One line per request, for debugging live runs. Path only: query strings carry OAuth codes.
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      if (req.path !== '/health') log(`[http] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true, chainId: opts.chain.chainId }));
  app.use('/x402', facilitatorRouter(deps, (m) => log(`[facilitator] ${m}`)));
  opts.extend?.(app, { relay, agent });

  const server: Server = createHttpServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/relay') return socket.destroy();
    // A page on another origin must not be able to open a relay socket with the user's cookie.
    if (opts.webOrigin && req.headers.origin && req.headers.origin !== opts.webOrigin) return socket.destroy();
    const account = await opts.authenticateSocket(req);
    if (!account) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tab = { send: (d: string) => ws.send(d), close: () => ws.close() };
      relay.attach(account, tab);
      log(`[relay] tab attached for ${account}`);
      ws.on('message', (data) => relay.onTabMessage(account, String(data)));
      ws.on('close', () => {
        relay.detach(account, tab);
        log(`[relay] tab detached for ${account}`);
      });
    });
  });

  return {
    app,
    server,
    relay,
    agent,
    facilitatorAddress: deps.address,
    listen: (port: number) => new Promise<number>((resolve) => {
      server.listen(port, () => resolve((server.address() as { port: number }).port));
    }),
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      server.close(() => resolve());
    }),
  };
}
