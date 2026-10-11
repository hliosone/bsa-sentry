// The production wiring, as a function so the e2e scripts run exactly this.
//
//   facilitator + relay + agent API  (app.ts)
//   + Ledger login (/auth)  + OAuth 2.1 (/oauth, /.well-known)  + MCP (/mcp)
//   + the dashboard event stream (/events)  + the built website, same origin
import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hex } from 'viem';
import { createServer } from './app.js';
import { authRouter, readSession } from './auth.js';
import { chainConfig } from './chain.js';
import { openDb } from './db.js';
import { mcpRouter } from './mcp.js';
import { oauthRouter } from './oauth.js';

export type BsaServerEnv = Record<string, string | undefined>;

export async function startBsaServer(env: BsaServerEnv = process.env, opts: { port?: number; log?: (m: string) => void } = {}) {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const log = opts.log ?? ((m: string) => console.log(m));
  const port = opts.port ?? Number(env.PORT ?? 8787);
  const secret = need('SESSION_SECRET');
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const chain = chainConfig(env);
  const db = openDb(env.DB_PATH ?? ':memory:');

  // PUBLIC_API_URL is what the outside world uses (the tunnel, or the deployed host). The
  // site is served from the same origin, so cookies stay first-party and SameSite=Lax works.
  if (!port) throw new Error('a fixed port is required (the OAuth issuer URL depends on it)');
  const baseUrl = (env.PUBLIC_API_URL ?? env.MCP_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const webOrigin = (env.WEB_ORIGIN ?? baseUrl).replace(/\/$/, '');
  const now = () => Math.floor(Date.now() / 1000);

  const bsa = createServer({
    chain,
    facilitatorKey: need('FACILITATOR_PRIVATE_KEY') as Hex,
    authenticateSocket: (req) => readSession(req, secret, now),
    webOrigin: env.WEB_ORIGIN,
    log,
    extend: (app, { relay, agent }) => {
      app.use('/auth', authRouter({
        db, chainId: chain.chainId, origin: webOrigin, secret, now, secureCookie: baseUrl.startsWith('https://'),
      }));
      app.use(oauthRouter({ db, baseUrl, webOrigin, secret, now }));
      app.use(mcpRouter({
        db, baseUrl, explorer: chain.explorer, agent,
        status: (a) => relay.status(a),
        hasBackup: (a) => !!db.prepare('SELECT 1 FROM vault WHERE account = ?').get(a),
        requestRestore: (a) => relay.requestRestore(a),
      }));

      // The dashboard's live feed: status changes, requests and answers for THIS account only.
      app.get('/events', (req, res) => {
        const account = readSession(req, secret, now);
        if (!account) return res.status(401).end();
        res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.flushHeaders();
        const send = (type: string, data: unknown) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`);
        send('status', { account, ...relay.status(account) });
        const handlers = ['status', 'request', 'answer'].map((type) => {
          const h = (e: { account: string }) => { if (e.account === account) send(type, e); };
          relay.events.on(type, h);
          return [type, h] as const;
        });
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          for (const [type, h] of handlers) relay.events.off(type, h);
        });
      });

      app.get('/api/config', (_req, res) => res.json({
        chainId: chain.chainId, chainName: chain.name, usdc: chain.usdc, explorer: chain.explorer,
        mcpUrl: `${baseUrl}/mcp`, merchantUrl: env.MERCHANT_URL ?? null,
      }));

      // The built website, if present. In dev, Vite proxies to us instead.
      const dist = resolve(env.WEB_DIST ?? resolve(import.meta.dirname, '../../web/dist'));
      if (existsSync(dist)) {
        app.use(express.static(dist, { index: 'index.html' }));
        app.get(/^\/(?!auth|oauth|mcp|x402|events|api|relay|health|\.well-known).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
      }
    },
  });

  const listening = await bsa.listen(port);
  log(`[server] listening on :${listening} · public ${baseUrl} · chain ${chain.name} (${chain.chainId}) · facilitator ${bsa.facilitatorAddress}`);
  return { ...bsa, db, port: listening, baseUrl };
}
