// The first screen: what this is, the Flex at the centre, and the two steps to get in.
import type { Bsa } from '../useBsa.js';
import { webHidAvailable } from '../device/flex.js';
import { shortAddr } from '../format.js';
import { FlexView } from '../components/FlexView.js';

export function Landing({ bsa }: { bsa: Bsa }) {
  const { signer, addresses } = bsa;
  return (
    <section className="hero">
      <div className="hero-copy">
        <h1>Your agent spends.<br />Your Ledger decides.</h1>
        <p className="lede">
          BSA Sentry keeps your AI agent's spending rules inside your Ledger Flex. The Flex pays on its own
          within them, asks you when it should, and refuses the rest, even when the agent is tricked.
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

        <ul className="hero-points">
          <li><b>Rules on the device</b><span>No website or server can change them.</span></li>
          <li><b>Claude can only ask</b><span>Every payment is decided by your Flex.</span></li>
          <li><b>Proof without identity</b><span>18 or older, a nationality, and nothing else.</span></li>
        </ul>
      </div>

      <div className="hero-stage">
        <FlexView screen={{ title: 'BSA Sentry', lines: ['Your agent spends.', 'Your Ledger decides.'] }} />
      </div>
    </section>
  );
}
