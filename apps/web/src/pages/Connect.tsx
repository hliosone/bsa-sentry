import type { Bsa } from '../useBsa.js';
import { webHidAvailable } from '../device/flex.js';

export function Connect({ bsa }: { bsa: Bsa }) {
  const { signer, account, addresses } = bsa;
  return (
    <section className="card">
      <h2>1. Connecter ton Flex</h2>
      <p>Branche ton Ledger Flex, déverrouille-le et ouvre l'app <b>BSA Sentry</b>.</p>
      {!webHidAvailable() && <p className="warn">Ce navigateur n'a pas WebHID. Utilise <b>Google Chrome</b>.</p>}
      {!signer ? (
        <button className="primary" onClick={bsa.connect} data-testid="connect">Connecter le Flex</button>
      ) : (
        <dl className="addresses">
          <dt>Compte principal (0xMAIN)</dt><dd><code>{addresses.main}</code></dd>
          <dt>Agent (0xAGENT)</dt><dd><code>{addresses.agent}</code></dd>
        </dl>
      )}

      <h2>2. Se connecter avec Ledger</h2>
      {account ? (
        <p className="ok" data-testid="logged-in">Connecté en tant que <code>{account}</code></p>
      ) : (
        <>
          <p>Ton Flex affiche le site et te demande de signer : c'est ta preuve de connexion, rien d'autre.</p>
          <button className="primary" disabled={!signer} onClick={bsa.login} data-testid="login">Se connecter avec Ledger</button>
        </>
      )}
    </section>
  );
}
