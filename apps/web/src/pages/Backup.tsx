import { useState } from 'react';
import type { Bsa } from '../useBsa.js';
import { runBackup, runRestore } from '../keyring/flows.js';

const STAGES: Record<string, string> = {
  checking: 'Lecture du Flex…', reading: 'Lecture des règles sur le Flex…', fetching: 'Récupération de la sauvegarde…',
  keyring: 'Ledger Sync : chiffrement sous ta seed…', saving: 'Envoi du texte chiffré…', reviewing: 'Vérifie et valide sur ton Flex…', done: 'Terminé',
};

export function Backup({ bsa }: { bsa: Bsa }) {
  const [result, setResult] = useState('');
  const go = () => bsa.run('Sauvegarde en cours…', async () => {
    const r = await runBackup(bsa.flowDeps((s) => setResult(STAGES[s!] ?? '')));
    setResult(r === 'backed_up' ? 'Sauvegardé : tes règles et ton badge, chiffrés par ta seed Ledger.' : 'Aucune règle active à sauvegarder.');
  });
  return (
    <section className="card">
      <h2>Sauvegarde Key Ring</h2>
      <p>Tes règles, tes marchands de confiance et ton badge 18+ sont chiffrés <b>par ta seed Ledger</b> (Ledger Key Ring) avant de quitter ce navigateur. Le serveur ne garde que du texte chiffré : il ne peut pas le lire.</p>
      <p>Si ton Flex est réinitialisé ou si tu réinstalles l'app, tu les restaures en une validation.</p>
      <ol className="steps-howto">
        <li>Le site lit tes règles sur le Flex (app BSA Sentry).</li>
        <li>Ton Flex passe sur l'app <b>Ledger Sync</b> pour chiffrer (confirmation la première fois).</li>
        <li>Retour sur BSA Sentry.</li>
      </ol>
      {bsa.hasBackup && <p className="ok" data-testid="backup-exists">Une sauvegarde existe.</p>}
      <button className="primary" disabled={!bsa.account || !bsa.device?.policy.active || !!bsa.busy} onClick={() => void go()} data-testid="backup">Sauvegarder maintenant</button>
      {result && <p data-testid="backup-result">{result}</p>}
    </section>
  );
}

export function Restore({ bsa }: { bsa: Bsa }) {
  const [result, setResult] = useState('');
  const go = () => bsa.run('Restauration en cours…', async () => {
    const r = await runRestore(bsa.flowDeps((s) => setResult(STAGES[s!] ?? '')));
    await bsa.refreshDevice();
    setResult({
      restored: 'Restauré : tes règles sont de nouveau sur le Flex. Démarre l\'agent dans les réglages de l\'app.',
      device_not_empty: 'Ce Flex a déjà des règles : bloque d\'abord l\'agent si tu veux les remplacer.',
      no_backup: 'Aucune sauvegarde pour ce compte.',
    }[r]);
  });
  return (
    <section className="card">
      <h2>Restauration</h2>
      <p>Pour un Flex réinitialisé ou une app réinstallée : la sauvegarde est déchiffrée par ta seed (Ledger Sync), puis ton Flex te montre <b>toutes</b> les règles restaurées avant de les accepter.</p>
      <button className="primary" disabled={!bsa.account || !!bsa.busy} onClick={() => void go()} data-testid="restore">Restaurer depuis la sauvegarde</button>
      {result && <p data-testid="restore-result">{result}</p>}
    </section>
  );
}
