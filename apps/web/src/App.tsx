import { useEffect, useState } from 'react';
import { useBsa } from './useBsa.js';
import { onboarding, type StepId } from './state/onboarding.js';
import { statusLine } from './state/status.js';
import { Connect } from './pages/Connect.js';
import { Rules } from './pages/Rules.js';
import { Session } from './pages/Session.js';
import { Claude } from './pages/Claude.js';
import { Dashboard } from './pages/Dashboard.js';
import { Later } from './pages/Later.js';
import { Badge } from './pages/Badge.js';

type Route = 'connect' | 'rules' | 'session' | 'claude' | 'dashboard' | 'badge' | 'backup' | 'restore';
const ROUTES: Route[] = ['connect', 'rules', 'session', 'claude', 'dashboard', 'badge', 'backup', 'restore'];
const STEP_ROUTE: Record<StepId, Route> = {
  connect: 'connect', login: 'connect', rules: 'rules', session: 'session', claude: 'claude', badge: 'badge', backup: 'backup', done: 'dashboard',
};

const routeFromHash = (): Route | null => {
  const r = location.hash.replace(/^#\//, '') as Route;
  return ROUTES.includes(r) ? r : null;
};

export function App() {
  const bsa = useBsa();
  const [route, setRoute] = useState<Route | null>(routeFromHash());
  useEffect(() => {
    const on = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const flow = onboarding({
    deviceConnected: !!bsa.signer,
    loggedIn: !!bsa.account,
    policyActive: !!bsa.device?.policy.active,
    sessionArmed: bsa.bridgeStatus.session || !!bsa.device?.sessionArmed,
    hasCredentials: !!bsa.device?.hasCredentials,
    hasBackup: false,
    // Claude counts as connected once the user went through the page; grants are listed there.
    claudeConnected: localStorage.getItem('bsa.claudeSeen') === '1',
  });
  const current = route ?? STEP_ROUTE[flow.current];
  useEffect(() => { if (current === 'claude') localStorage.setItem('bsa.claudeSeen', '1'); }, [current]);

  const status = statusLine({
    socket: bsa.bridgeStatus.socket,
    flex: bsa.signer ? bsa.bridgeStatus.flex === 'disconnected' && bsa.account ? 'disconnected' : bsa.bridgeStatus.flex : 'disconnected',
    session: bsa.bridgeStatus.session,
    policyActive: !!bsa.device?.policy.active,
  });

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo">◆</span> BSA Sentry</div>
        <div className="tagline">Your agent spends. Your Ledger decides.</div>
        {bsa.account && <button className="ghost small" onClick={() => void bsa.logout()}>Déconnexion</button>}
      </header>
      <div className={`statusbar ${bsa.account ? status.level : 'warn'}`} data-testid="statusbar">
        {bsa.account ? status.text : 'Connecte ton Flex puis connecte-toi avec Ledger'}
      </div>

      <div className="layout">
        <nav>
          {flow.steps.map((s) => (
            <a key={s.id} href={`#/${STEP_ROUTE[s.id]}`} className={`${s.done ? 'done' : ''} ${STEP_ROUTE[s.id] === current ? 'active' : ''}`}>
              <span className="tick">{s.done ? '✓' : s.optional ? '○' : '•'}</span> {s.label}
            </a>
          ))}
          <a href="#/dashboard" className={current === 'dashboard' ? 'active' : ''}><span className="tick">▸</span> Tableau de bord</a>
        </nav>

        <main>
          {bsa.busy && <div className="device-prompt" data-testid="device-prompt"><span className="pulse" /> {bsa.busy}</div>}
          {bsa.error && <div className="error" role="alert">{bsa.error} <button className="ghost" onClick={bsa.clearError}>×</button></div>}
          {current === 'connect' && <Connect bsa={bsa} />}
          {current === 'rules' && <Rules bsa={bsa} />}
          {current === 'session' && <Session bsa={bsa} />}
          {current === 'claude' && <Claude bsa={bsa} />}
          {current === 'dashboard' && <Dashboard bsa={bsa} />}
          {current === 'badge' && <Badge bsa={bsa} />}
          {current === 'backup' && <Later title="Sauvegarde Key Ring">Sauvegarde tes règles, chiffrées par ta seed Ledger.</Later>}
          {current === 'restore' && <Later title="Restauration">Restaure tes règles sur un Flex réinitialisé.</Later>}
        </main>
      </div>
    </div>
  );
}
