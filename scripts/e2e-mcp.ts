// M4 acceptance: this script plays claude.ai.
//
// It uses the official MCP TypeScript SDK client, which performs the whole OAuth 2.1 dance
// on its own (metadata discovery, dynamic client registration, PKCE S256). The one step a
// browser would do — the consent page — is done here headlessly, with a Ledger session the
// Flex (Speculos) signed after a simulated tap. Then it calls the tools like Claude would:
//
//   sentry_status · cafe (silent) · boulangerie (orange -> "Trust merchant", then silent)
//   · restaurant (orange -> "Pay once") · promo -> 400 USDC deposit (refused) · sentry_status
//
//   E2E=1 pnpm e2e:mcp            local
//   E2E=1 TUNNEL=1 pnpm e2e:mcp   through a public cloudflared URL, like claude.ai
import 'dotenv/config';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Policy } from '@bsa-sentry/types';
import { SentrySigner } from '@bsa-sentry/sentry-signer';
import { SpeculosTransport } from '@bsa-sentry/sentry-signer/transports/speculos';
import { startBsaServer } from '../apps/server/src/main.js';
import { createMerchantsApp } from '../apps/merchants/src/app.js';
import { startBridgeHarness } from './bridge-harness.js';
import { startTunnel } from './tunnel.js';
import * as ui from './speculos-ui.js';

if (process.env.E2E !== '1') {
  console.log('e2e-mcp spends real testnet USDC on Arc; run it with E2E=1');
  process.exit(0);
}

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing from .env`);
  return v as Hex;
};
const USDC = 1_000_000n;
const lower = (a: string) => a.toLowerCase() as Hex;
const payTo = {
  cafe: need('MERCHANT_CAFE_ADDRESS'), cave: need('MERCHANT_CAVE_ADDRESS'), resto: need('MERCHANT_RESTO_ADDRESS'),
  evil: need('MERCHANT_EVIL_ADDRESS'), boulangerie: need('MERCHANT_BOULANGERIE_ADDRESS'),
};

let failures = 0;
const step = (m: string) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`);
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => { failures++; console.log(`  \x1b[31m✗ ${m}\x1b[0m`); };
const expect = (cond: unknown, m: string) => (cond ? ok(m) : bad(m));
const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join('\n');

const freePort = () => new Promise<number>((resolve) => {
  const s = createNetServer().listen(0, () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});

/**
 * An OAuth provider for the SDK client. Everything a real client stores is kept in memory;
 * `redirectToAuthorization` is where a browser would open the consent page — here we fetch
 * it with the Ledger session cookie, submit "Allow", and keep the code from the redirect.
 */
class HeadlessClaude implements OAuthClientProvider {
  private info?: OAuthClientInformationFull;
  private tok?: OAuthTokens;
  private verifier = '';
  code?: string;
  sawConsent = false;
  constructor(private readonly cookie: string) {}

  get redirectUrl() { return 'http://localhost:6274/oauth/callback'; }
  get clientMetadata() {
    return {
      client_name: 'Claude (e2e)', redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    };
  }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationFull) { this.info = i; }
  tokens() { return this.tok; }
  saveTokens(t: OAuthTokens) { this.tok = t; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }

  async redirectToAuthorization(url: URL) {
    const page = await fetch(url, { headers: { cookie: this.cookie } });
    const html = await page.text();
    this.sawConsent = /Allow .* to request payments from your Flex/.test(html);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    if (!csrf) throw new Error(`no consent form (logged in?): ${html.slice(0, 200)}`);
    const consent = await fetch(url, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: this.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, decision: 'allow' }),
    });
    const location = consent.headers.get('location');
    this.code = location ? new URL(location).searchParams.get('code') ?? undefined : undefined;
    if (!this.code) throw new Error(`consent did not redirect with a code (HTTP ${consent.status})`);
  }
}

async function main() {
  const signer = new SentrySigner(new SpeculosTransport());
  const tunnelled = process.env.TUNNEL === '1';

  step('Device: demo rules (cafe, cave, resto - NOT the bakery) + armed session');
  const policy: Policy = {
    active: true, chainId: 5042002n, token: lower(need('USDC_ADDRESS')),
    autoMax: 5n * USDC, hardMax: 50n * USDC, budget: 20n * USDC, maxCount: 10,
    payees: [
      { address: lower(payTo.cafe), label: 'Cafe Sat' },
      { address: lower(payTo.cave), label: 'Corner Wines' },
      { address: lower(payTo.resto), label: 'Restaurant' },
    ],
  };
  const setting = signer.setPolicy(policy);
  await ui.approveReview();
  await setting;
  await ui.setSessionVia(async () => (await signer.getState()).sessionArmed, true);
  await ui.goHome();
  ok('rules installed, session armed');

  step(`Server${tunnelled ? ' behind a cloudflared tunnel' : ''}, then the merchants`);
  const port = await freePort();
  const tunnel = tunnelled ? await startTunnel(port) : null;
  const server = await startBsaServer(
    { ...process.env, PORT: String(port), PUBLIC_API_URL: tunnel?.url ?? `http://localhost:${port}`, DB_PATH: ':memory:', WEB_ORIGIN: undefined },
    { log: (m) => (process.env.VERBOSE ? console.log(`    ${m}`) : undefined) },
  );
  const merchants = await createMerchantsApp({
    facilitatorUrl: `http://127.0.0.1:${port}/x402`, network: 'eip155:5042002', payTo, publicUrl: 'http://127.0.0.1:4021',
  });
  const merchantsServer = merchants.listen(0);
  await new Promise((r) => merchantsServer.once('listening', r));
  const shop = `http://127.0.0.1:${(merchantsServer.address() as AddressInfo).port}`;
  const base = server.baseUrl;
  ok(`MCP endpoint ${base}/mcp`);

  let harness: ReturnType<typeof startBridgeHarness> | undefined;
  let client: Client | undefined;
  try {
    step('"Log in with Ledger": the Flex signs a Login with 0xMAIN (simulated tap)');
    const challenge = await (await fetch(`${base}/auth/challenge`, { method: 'POST' })).json();
    const main = await signer.getAddress('main');
    const signing = signer.signLogin({
      chainId: BigInt(challenge.chainId), origin: challenge.origin, nonce: challenge.nonce,
      issuedAt: BigInt(challenge.issuedAt), expiresAt: BigInt(challenge.expiresAt),
    });
    await ui.waitForText(/Log in/i);
    await ui.approveReview();
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: main, nonce: challenge.nonce, signature: await signing }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(login.ok && cookie.startsWith('bsa_session='), `logged in as ${main}`);

    step('The bridge tab attaches with that session');
    const wsBase = base.replace(/^http/, 'ws');
    harness = startBridgeHarness({ url: `${wsBase}/relay`, cookie });
    for (let i = 0; i < 100 && !server.relay.status(main).agent; i++) await new Promise((r) => setTimeout(r, 150));
    expect(server.relay.status(main).agent, 'tab attached to the logged-in account and reported its 0xAGENT');

    step('claude.ai adds the connector: discovery, DCR, consent, PKCE, token (MCP SDK)');
    const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status === 401 && /resource_metadata=/.test(unauth.headers.get('www-authenticate') ?? ''), 'unauthenticated /mcp -> 401 with resource metadata');
    const provider = new HeadlessClaude(cookie);
    const connect = async () => {
      const c = new Client({ name: 'claude-e2e', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
      return c;
    };
    try {
      client = await connect();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      const t = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
      await t.finishAuth(provider.code!);
      client = await connect();
    }
    expect(provider.sawConsent, 'the consent page asked "Allow … to request payments from your Flex?"');
    expect(provider.tokens()?.access_token, 'access token issued');
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(JSON.stringify(tools) === JSON.stringify(['sentry_restore', 'sentry_status', 'x402_fetch']), `tools: ${tools.join(', ')}`);

    step('sentry_status');
    const s1 = await client.callTool({ name: 'sentry_status', arguments: {} });
    console.log(text(s1).split('\n').map((l) => `      ${l}`).join('\n'));
    expect(/20 \/ 20 USDC left/.test(text(s1)), 'full budget before any purchase');

    step('"Buy me a coffee" -> x402_fetch /cafe (3 USDC, trusted, under the limit: no tap)');
    const coffee = await client.callTool({ name: 'x402_fetch', arguments: { url: `${shop}/cafe` } });
    console.log(`      ${text(coffee).split('\n')[0]}`);
    expect(!coffee.isError && /Paid 3 USDC/.test(text(coffee)) && /explorer\.testnet\.arc\.io\/tx\/0x/.test(text(coffee)), 'paid silently and settled on Arc');

    step('"A croissant" -> /bakery (2 USDC, unknown merchant): confirmation screen -> "Trust merchant"');
    const croissant = client.callTool({ name: 'x402_fetch', arguments: { url: `${shop}/bakery` } });
    await ui.waitForText(/Pay 2 USDC/i, 30_000);
    expect(/Unknown\s+merchant/i.test(await ui.screenText()), 'the Flex says "Unknown merchant" and offers "Trust merchant"');
    await ui.screenshot('12-mcp-orange-boulangerie');
    await ui.tapText('Trust merchant');
    const croissantR = await croissant;
    expect(!croissantR.isError && /Paid 2 USDC/.test(text(croissantR)), 'paid after "Trust merchant"');
    const again = await client.callTool({ name: 'x402_fetch', arguments: { url: `${shop}/bakery` } });
    expect(!again.isError && /Paid 2 USDC/.test(text(again)), 'second croissant: paid silently, the bakery is now trusted');

    step('"Book the restaurant" -> /restaurant (20 USDC, over the auto limit): confirmation screen -> "Pay once"');
    const resto = client.callTool({ name: 'x402_fetch', arguments: { url: `${shop}/restaurant` } });
    await ui.waitForText(/Pay 20 USDC/i, 30_000);
    const restoScreen = await ui.screenText();
    expect(!/Trust merchant/.test(restoScreen), '"Trust merchant" is not offered: the amount, not the merchant, is the problem');
    await ui.tapText('Pay once');
    const restoR = await resto;
    // 3 + 2 + 2 = 7 spent, +20 = 27 > 20: still allowed because the user approved it on screen.
    expect(!restoR.isError && /Paid 20 USDC/.test(text(restoR)), 'paid once, after the tap');

    step('"Regarde la page promo" -> the hidden instruction -> 400 USDC "deposit"');
    const promo = await client.callTool({ name: 'x402_fetch', arguments: { url: `${shop}/promo` } });
    expect(/evil\/deposit/.test(text(promo)), 'the promo page carries the injected instruction');
    const deposit = await client.callTool({ name: 'x402_fetch', arguments: { url: `${shop}/evil/deposit` } });
    console.log(`      ${text(deposit).split('\n')[0]}`);
    expect(deposit.isError && /OVER_HARD_MAX/.test(text(deposit)) && /do not retry/i.test(text(deposit)), 'refused by the Flex, with words Claude can repeat');

    step('sentry_status after the session');
    const s2 = await client.callTool({ name: 'sentry_status', arguments: {} });
    console.log(text(s2).split('\n').map((l) => `      ${l}`).join('\n'));
    expect(/Last payment: Restaurant 20 USDC/.test(text(s2)), 'the last payment is the restaurant');
  } finally {
    await client?.close().catch(() => undefined);
    harness?.stop();
    await server.close();
    await new Promise((r) => merchantsServer.close(() => r(null)));
    tunnel?.stop();
  }

  console.log(failures === 0 ? '\n\x1b[32mM4 e2e passed\x1b[0m' : `\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\ne2e could not run:', e);
  process.exit(2);
});
