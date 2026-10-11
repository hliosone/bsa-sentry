// Shared pieces of the end-to-end scripts: the stack (server + merchants + bridge), the Ledger
// login on Speculos, and a headless claude.ai (the MCP SDK client with OAuth).
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SentrySigner } from '@bsa-sentry/sentry-signer';
import { startBsaServer } from '../apps/server/src/main.js';
import { createMerchantsApp } from '../apps/merchants/src/app.js';
import { startBridgeHarness } from './bridge-harness.js';
import * as ui from './speculos-ui.js';

export const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} missing from .env`); return v as Hex; };

export function reporter() {
  let failures = 0;
  return {
    step: (m: string) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`),
    ok: (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
    expect: (c: unknown, m: string) => { if (c) console.log(`  \x1b[32m✓\x1b[0m ${m}`); else { failures++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); } },
    failures: () => failures,
  };
}

export const freePort = () => new Promise<number>((r) => {
  const s = createNetServer().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); });
});

export const merchantAddresses = () => ({
  cafe: need('MERCHANT_CAFE_ADDRESS'), cave: need('MERCHANT_CAVE_ADDRESS'), resto: need('MERCHANT_RESTO_ADDRESS'),
  evil: need('MERCHANT_EVIL_ADDRESS'), boulangerie: need('MERCHANT_BOULANGERIE_ADDRESS'),
});

/** Server (real wiring) + merchants, in-process. `publicUrl` is the tunnel URL when there is one. */
export async function startStack(opts: { port?: number; publicUrl?: string } = {}) {
  const port = opts.port ?? await freePort();
  const server = await startBsaServer(
    { ...process.env, PORT: String(port), PUBLIC_API_URL: opts.publicUrl ?? `http://localhost:${port}`, DB_PATH: ':memory:', WEB_ORIGIN: undefined, EUDIW_MODE: 'mock' },
    { log: (m) => (process.env.VERBOSE ? console.log(`    ${m}`) : undefined) },
  );
  const merchants = await createMerchantsApp({ facilitatorUrl: `http://127.0.0.1:${port}/x402`, network: 'eip155:5042002', payTo: merchantAddresses(), publicUrl: 'http://127.0.0.1:0' });
  const ms = merchants.listen(0);
  await new Promise((r) => ms.once('listening', r));
  const shop = `http://127.0.0.1:${(ms.address() as AddressInfo).port}`;
  return {
    server, shop, base: server.baseUrl, local: `http://localhost:${port}`,
    stop: async () => { await server.close(); await new Promise((r) => ms.close(() => r(null))); },
  };
}

/** "Se connecter avec Ledger" with the Flex being Speculos: returns the session cookie. */
export async function ledgerLogin(signer: SentrySigner, base: string): Promise<{ cookie: string; main: Hex }> {
  const ch = await (await fetch(`${base}/auth/challenge`, { method: 'POST' })).json();
  const main = await signer.getAddress('main');
  const signing = signer.signLogin({ chainId: BigInt(ch.chainId), origin: ch.origin, nonce: ch.nonce, issuedAt: BigInt(ch.issuedAt), expiresAt: BigInt(ch.expiresAt) });
  await ui.waitForText(/Se connecter/i);
  await ui.approveReview();
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: main, nonce: ch.nonce, signature: await signing }) });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  return { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0]!, main };
}

/** The bridge tab, attached with the session; resolves once it reported its 0xAGENT. */
export async function attachBridge(stack: Awaited<ReturnType<typeof startStack>>, cookie: string, main: Hex) {
  const harness = startBridgeHarness({ url: `${stack.base.replace(/^http/, 'ws')}/relay`, cookie });
  for (let i = 0; i < 100 && !stack.server.relay.status(main).agent; i++) await new Promise((r) => setTimeout(r, 150));
  if (!stack.server.relay.status(main).agent) throw new Error('the bridge did not attach');
  return harness;
}

/** claude.ai's half of the OAuth dance; the consent page is answered with the Ledger session. */
export class HeadlessClaude implements OAuthClientProvider {
  private info?: OAuthClientInformationFull;
  private tok?: OAuthTokens;
  private verifier = '';
  code?: string;
  sawConsent = false;
  constructor(private readonly cookie: string) {}
  get redirectUrl() { return 'http://localhost:6274/oauth/callback'; }
  get clientMetadata() {
    return { client_name: 'Claude (e2e)', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_post' };
  }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationFull) { this.info = i; }
  tokens() { return this.tok; }
  saveTokens(t: OAuthTokens) { this.tok = t; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  async redirectToAuthorization(url: URL) {
    const html = await (await fetch(url, { headers: { cookie: this.cookie } })).text();
    this.sawConsent = /Autoriser .* à demander des paiements à ton Flex/.test(html);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    if (!csrf) throw new Error('no consent form');
    const consent = await fetch(url, { method: 'POST', redirect: 'manual', headers: { cookie: this.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, decision: 'allow' }) });
    this.code = new URL(consent.headers.get('location')!).searchParams.get('code') ?? undefined;
  }
}

/** Connects an MCP client the way claude.ai does, OAuth included. */
export async function connectClaude(base: string, cookie: string) {
  const provider = new HeadlessClaude(cookie);
  const connect = async () => {
    const c = new Client({ name: 'claude-e2e', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
    return c;
  };
  try {
    return { client: await connect(), provider };
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    await new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }).finishAuth(provider.code!);
    return { client: await connect(), provider };
  }
}

export const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join('\n');
