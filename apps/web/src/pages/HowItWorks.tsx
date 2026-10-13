// The logged-in overview: the three parts of BSA Sentry, how each one works step by step, how a
// shop adds BSA Sentry payments, how an agent connects, and the live demo shops.
// It only reads `bsa.config`, so it renders the same before and after setup.
import type { Bsa } from '../useBsa.js';
import type { Config } from '../api.js';
import { EudiMark, Pillars } from '../components/Pillars.js';
import './overview.css';

const DEFAULT_CHAIN_ID = 5042002; // Arc testnet

/** Our facilitator is mounted at /x402 on the same server as /mcp. */
export const facilitatorUrl = (config: Config | null) =>
  config?.mcpUrl ? config.mcpUrl.replace(/\/mcp$/, '/x402') : 'https://<bsa-sentry-server>/x402';

/**
 * How a shop takes BSA Sentry payments: a trim of apps/merchants/src/app.ts (createMerchantsApp)
 * with the wine route written out. Stock x402 middleware; our facilitator does the checking.
 * test/overview.test.ts checks the imports still match that file.
 */
export function merchantSnippet(o: { facilitatorUrl: string; chainId: number }): string {
  const network = `eip155:${o.chainId}`;
  return `import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

// The BSA Sentry facilitator checks payment and rights, then settles.
const facilitator = new HTTPFacilitatorClient({ url: '${o.facilitatorUrl}' });
const resourceServer = new x402ResourceServer(facilitator)
  .register('${network}', new ExactEvmScheme());

app.use(paymentMiddleware({
  'GET /wine': {
    accepts: {
      scheme: 'exact', price: '$4.5', network: '${network}',
      payTo: process.env.MERCHANT_CAVE_ADDRESS,
      extra: { requires: ['age_over_18'] }, // or 'jurisdiction_not:US'
    },
    description: 'Corner Wines - a bottle',
  },
}, resourceServer));`;
}

export function MerchantSnippet({ config }: { config: Config | null }) {
  const code = merchantSnippet({ facilitatorUrl: facilitatorUrl(config), chainId: config?.chainId ?? DEFAULT_CHAIN_ID });
  return <pre className="ov-code" data-testid="merchant-snippet"><code>{code}</code></pre>;
}

/** The demo shops (apps/merchants), as the agent reaches them. */
export const SHOPS = [
  { path: '/cafe', name: 'Cafe Sat', what: 'An espresso, 3 USDC', note: 'A trusted merchant in the demo rules: paid without asking.' },
  { path: '/bakery', name: 'Bakery', what: 'A croissant, 2 USDC', note: 'Not trusted yet: your Flex offers "Trust merchant".' },
  { path: '/restaurant', name: 'Restaurant', what: 'A table for two, 20 USDC', note: 'Above the automatic limit: your Flex asks you.' },
  { path: '/wine', name: 'Corner Wines', what: 'A bottle, 4.5 USDC', note: 'Requires 18 or older.' },
  { path: '/presale', name: 'Token Presale', what: '500 STY, 5 USDC', note: 'Requires: not a US person.' },
  { path: '/promo', name: 'Deals page', what: 'Free', note: 'Hides a 400 USDC "deposit" aimed at agents: your Flex refuses it.' },
] as const;

/** Where a demo shop lives: MERCHANT_URL is the shops' base when set, else this server's /shops. */
export const shopUrl = (merchantUrl: string | null | undefined, path: string) =>
  merchantUrl ? `${merchantUrl.replace(/\/$/, '')}${path}` : `/shops${path}`;

export function HowItWorks({ bsa }: { bsa: Bsa }) {
  const config = bsa.config;
  const mcpUrl = config?.mcpUrl;

  return (
    <>
      <section className="card">
        <h2>How BSA Sentry works</h2>
        <p>BSA Sentry gives an AI agent a mandate held by your Ledger. Our own Flex app is its wallet and enforces its spending limits, your EU Digital Identity Wallet supplies the rights shops ask for, and x402 rails let any agent pay any shop. The agent acts on its own inside the mandate; you decide only at its boundary, on the Flex.</p>
        <Pillars />
      </section>

      <section className="card" data-testid="how-rules">
        <h2>1. Your own Ledger app</h2>
        <ol className="ov-flow">
          <li>You set the rules: trusted merchants, an automatic limit, a ceiling, a budget and a number of payments. The Flex shows them in full and you approve them on the device.</li>
          <li>You start the agent on the Flex itself (Agent session): no website or server can do it. Keep this site open in Chrome with the Flex plugged in.</li>
          <li>Your agent asks to pay. The request reaches the Flex through this tab; the server can only ask.</li>
          <li>The Flex decides, and a signed payment settles in USDC on Arc testnet.</li>
        </ol>
        <ul className="ov-outcomes">
          <li className="is-signed"><b>Within the rules</b><span>Signed on its own, in about a second.</span></li>
          <li className="is-asked"><b>Outside a soft rule</b><span>It asks you: Reject, Pay once or Trust merchant. 60 seconds of silence is a no.</span></li>
          <li className="is-refused"><b>Above the ceiling, or session off</b><span>Refused. No tap can override it.</span></li>
        </ul>
        <p className="ov-link"><a href="#/rules">Open the rules</a></p>
      </section>

      <section className="card" data-testid="how-identity">
        <div className="ov-head">
          <h2>2. Know Your Agent, from your EU wallet</h2>
          <EudiMark height={48} />
        </div>
        <ol className="ov-flow">
          <li>Scan a QR code with an EU Digital Identity Wallet app (tested with Paradym) and share.</li>
          <li>The presentation is verified by the EU Digital Identity Wallet reference verifier (OpenID4VP, SD-JWT PID): the issuer's signature, the key binding and the nonce.</li>
          <li>The wallet shares only your date of birth, your nationality and the country that issued your ID. We derive "18 or older" and a jurisdiction (nationality first), and keep nothing else.</li>
          <li>Your Flex links the result to your Ledger account, then grants the rights you choose to your agent. Each step is shown on the Flex.</li>
          <li>A shop that requires a right gets the proof with the payment, and our facilitator checks it. The shop learns the right, not who you are. You can revoke it at any time.</li>
        </ol>
        <p className="ov-note">Demo: a test PID from a test issuer. In production: your member state's PID.</p>
        <p className="ov-link"><a href="#/badge">Open agent identity</a></p>
      </section>

      <section className="card" data-testid="how-rails">
        <h2>3. Agentic commerce rails</h2>
        <ol className="ov-flow">
          <li>Your agent calls <code>x402_fetch</code> on a shop's URL through the BSA Sentry MCP server.</li>
          <li>The shop answers HTTP 402 with its price and, if it wants, the rights it requires.</li>
          <li>Your Flex decides. The signed USDC authorization, with the proof of rights if asked, goes back to the shop.</li>
          <li>The shop's x402 middleware asks our facilitator. It checks the signature, payee, amount, rights and balance, then settles on Arc testnet.</li>
        </ol>
      </section>

      <section className="card" data-testid="how-merchants">
        <h2>For merchants</h2>
        <p>Keep the standard x402 middleware and point it at the BSA Sentry facilitator. To require a right, list it in <code>extra.requires</code>: <code>age_over_18</code>, <code>jurisdiction_not:US</code> or <code>jurisdiction_in:FR,DE</code>.</p>
        <MerchantSnippet config={config} />
        <p className="muted">The middleware enforces nothing by itself. The facilitator does: without a valid proof of the rights you list, it refuses the payment.</p>

        <h3>Live demo shops</h3>
        <p className="muted">The paid shops answer with an HTTP 402 payment request. Ask your agent, for example: <code>Buy me a coffee at {shopUrl(config?.merchantUrl, '/cafe')}</code></p>
        <ul className="ov-shops">
          {SHOPS.map((s) => {
            const url = shopUrl(config?.merchantUrl, s.path);
            return (
              <li key={s.path} data-testid={`shop-${s.path.slice(1)}`}>
                <a href={url} target="_blank" rel="noreferrer">{s.name}</a>
                <span className="ov-shop-what">{s.what}</span>
                <span className="ov-shop-note">{s.note}</span>
                <code>{url}</code>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card" data-testid="how-agents">
        <h2>For agents (MCP)</h2>
        <p>BSA Sentry is a remote MCP server with OAuth. It works with any MCP client that supports remote servers with OAuth (tested with Claude).</p>
        {mcpUrl && <p className="ov-url"><code>{mcpUrl}</code></p>}
        <ul className="ov-tools">
          <li><code>x402_fetch</code> fetches a URL and pays with x402 when asked, if your Flex agrees.</li>
          <li><code>sentry_status</code> shows whether the Flex is reachable, the agent is on, and the budget left.</li>
          <li><code>sentry_restore</code> restores your rules and rights onto a wiped Flex from your Ledger Key Ring backup.</li>
        </ul>
        <p className="muted">The access you grant only lets the agent ask for payments, and you can revoke it.</p>
        <p className="ov-link"><a href="#/claude">Connect your agent step by step</a></p>
      </section>
    </>
  );
}
