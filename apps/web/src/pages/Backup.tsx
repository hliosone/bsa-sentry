import { useState } from 'react';
import type { Bsa } from '../useBsa.js';
import { runBackup, runRestore } from '../keyring/flows.js';

const STAGES: Record<string, string> = {
  checking: 'Reading the Flex…', reading: 'Reading the rules on the Flex…', fetching: 'Fetching the backup…',
  keyring: 'Ledger Sync: encrypting under your seed…', saving: 'Uploading the ciphertext…', reviewing: 'Check and approve on your Flex…', done: 'Done',
};

export function Backup({ bsa }: { bsa: Bsa }) {
  const [result, setResult] = useState('');
  const go = () => bsa.run('Backing up…', async () => {
    const r = await runBackup(bsa.flowDeps((s) => setResult(STAGES[s!] ?? '')));
    setResult(r === 'backed_up' ? 'Backed up: your rules, trusted merchants and agent identity rights, encrypted by your Ledger seed.' : 'No active rules to back up.');
  });
  return (
    <section className="card">
      <h2>Key Ring backup</h2>
      <p>Everything your Flex holds for your agent: the spending rules, the trusted merchants, and the agent identity rights you granted (18 or older, jurisdiction). It is encrypted <b>by your Ledger seed</b> (Ledger Key Ring) before it leaves this browser. The server only keeps ciphertext and cannot read it.</p>
      <p>If your Flex is reset or you reinstall the app, you get it all back with one approval on the Flex.</p>
      <ol className="steps-howto">
        <li>The website reads your rules and rights from the Flex (BSA Sentry app).</li>
        <li>Your Flex switches to the <b>Ledger Sync</b> app to encrypt (confirmation the first time).</li>
        <li>Back to BSA Sentry.</li>
      </ol>
      {bsa.hasBackup && <p className="ok" data-testid="backup-exists">A backup exists.</p>}
      <button className="primary" disabled={!bsa.account || !bsa.device?.policy.active || !!bsa.busy} onClick={() => void go()} data-testid="backup">Back up now</button>
      {result && <p data-testid="backup-result">{result}</p>}
    </section>
  );
}

export function Restore({ bsa }: { bsa: Bsa }) {
  const [result, setResult] = useState('');
  const go = () => bsa.run('Restoring…', async () => {
    const r = await runRestore(bsa.flowDeps((s) => setResult(STAGES[s!] ?? '')));
    await bsa.refreshDevice();
    setResult({
      restored: 'Restored: your rules and agent identity rights are back on the Flex. Start the agent in the app settings.',
      device_not_empty: 'This Flex already has rules: block the agent first if you want to replace them.',
      no_backup: 'No backup for this account.',
    }[r]);
  });
  return (
    <section className="card">
      <h2>Restore</h2>
      <p>For a reset Flex or a reinstalled app: the backup is decrypted by your seed (Ledger Sync), then your Flex shows you <b>every</b> restored rule and right before accepting them.</p>
      <button className="primary" disabled={!bsa.account || !!bsa.busy} onClick={() => void go()} data-testid="restore">Restore from backup</button>
      {result && <p data-testid="restore-result">{result}</p>}
    </section>
  );
}
