import type { Bsa } from '../useBsa.js';
import { webHidAvailable } from '../device/flex.js';

export function Connect({ bsa }: { bsa: Bsa }) {
  const { signer, account, addresses } = bsa;
  return (
    <section className="card">
      <h2>Connect your Flex</h2>
      <p>Plug in your Ledger Flex, unlock it and open the <b>BSA Sentry</b> app.</p>
      {!webHidAvailable() && <p className="warn">This browser has no WebHID. Use <b>Google Chrome</b>.</p>}
      {!signer ? (
        <button className="primary" onClick={bsa.connect} data-testid="connect">Connect the Flex</button>
      ) : (
        <dl className="addresses">
          <dt>Main account (0xMAIN)</dt><dd><code>{addresses.main}</code></dd>
          <dt>Agent (0xAGENT)</dt><dd><code>{addresses.agent}</code></dd>
        </dl>
      )}

      <h2>Log in with Ledger</h2>
      {account ? (
        <p className="ok" data-testid="logged-in">Logged in as <code>{account}</code></p>
      ) : (
        <>
          <p>Your Flex shows this website and asks you to sign: that is your proof of login, nothing else.</p>
          <button className="primary" disabled={!signer} onClick={bsa.login} data-testid="login">Log in with Ledger</button>
        </>
      )}
    </section>
  );
}
