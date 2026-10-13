// The first screen: the three parts of BSA Sentry, the Flex at the centre, the two steps to get
// in, then what it means for merchants and for agents.
import type { Bsa } from '../useBsa.js';
import { webHidAvailable } from '../device/flex.js';
import { shortAddr } from '../format.js';
import { FlexView } from '../components/FlexView.js';
import { Pillars } from '../components/Pillars.js';
import { MerchantSnippet } from './HowItWorks.js';
import './overview.css';

export function Landing({ bsa }: { bsa: Bsa }) {
  const { signer, addresses } = bsa;
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>Know Your Agent,<br />enforced by your Ledger.</h1>
          <p className="lede">
            BSA Sentry gives your AI agent a mandate held by your Ledger. Our own Flex app is the agent's wallet: it
            pays trusted shops on its own and asks you only at the boundary. Your EU Digital Identity Wallet proves what
            a shop needs to know (18 or older, a jurisdiction), never who you are. Payments settle in USDC on Arc
            through x402 rails that any agent and any shop can use.
          </p>

          <ol className="hero-steps">
            <li className={signer ? 'done' : ''}>
              <div>
                <b>Connect your Flex</b>
                <span>{signer ? <>Connected: <code>{shortAddr(addresses.main)}</code></> : 'Plug it in, unlock it and open the BSA Sentry app.'}</span>
              </div>
              {!signer && <button className="primary" onClick={bsa.connect} data-testid="connect" disabled={!webHidAvailable()}>Connect the Flex</button>}
            </li>
            <li>
              <div>
                <b>Log in with Ledger</b>
                <span>Your Flex shows this website and asks you to sign. That is the whole login.</span>
              </div>
              <button className="primary" disabled={!signer} onClick={bsa.login} data-testid="login">Log in with Ledger</button>
            </li>
          </ol>
          {!webHidAvailable() && <p className="warn">This browser has no WebHID: open this page in Google Chrome.</p>}

          <Pillars compact />
        </div>

        <div className="hero-stage">
          <FlexView screen={{ title: 'BSA Sentry', lines: ['Know Your Agent,', 'enforced by your Ledger.'] }} />
        </div>
      </section>

      <section className="ov-audiences" aria-label="For merchants and agents">
        <article className="card">
          <h2>For merchants</h2>
          <p>Keep the standard x402 middleware and point it at the BSA Sentry facilitator. List the rights you need (18 or older, not a US person): you get paid in USDC on Arc and learn the right, not the person.</p>
          <MerchantSnippet config={bsa.config} />
        </article>
        <article className="card">
          <h2>For agents (MCP)</h2>
          <p>Add BSA Sentry as a remote MCP server. It works with any MCP client that supports remote servers with OAuth (tested with Claude).</p>
          {bsa.config?.mcpUrl && <p className="ov-url"><code>{bsa.config.mcpUrl}</code></p>}
          <p>The agent gets <code>x402_fetch</code> and can only ask. Your Flex decides every payment.</p>
        </article>
      </section>
    </>
  );
}
