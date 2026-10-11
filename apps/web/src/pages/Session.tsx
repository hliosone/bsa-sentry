import type { Bsa } from '../useBsa.js';

export function Session({ bsa }: { bsa: Bsa }) {
  const armed = bsa.bridgeStatus.session || !!bsa.device?.sessionArmed;
  return (
    <section className="card">
      <h2>Démarrer l'agent sur le Flex</h2>
      <p>Seul le Flex peut démarrer l'agent : aucun site, aucun serveur ne peut le faire à ta place. Un redémarrage de l'app l'arrête.</p>
      <ol className="steps-howto">
        <li>Sur l'écran d'accueil de BSA Sentry, touche l'icône réglages en haut à droite.</li>
        <li>Active <b>Agent session</b>.</li>
      </ol>
      {armed ? (
        <p className="ok" data-testid="session-on">Agent démarré.</p>
      ) : (
        <button className="primary" onClick={() => void bsa.refreshDevice()} data-testid="session-check">J'ai démarré l'agent</button>
      )}
    </section>
  );
}
