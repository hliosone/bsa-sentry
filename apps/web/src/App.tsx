import { useEffect, useState } from 'react';
import { useBsa } from './useBsa.js';
import { onboarding, type StepId } from './state/onboarding.js';
import { statusLine } from './state/status.js';
import { shortAddr } from './format.js';
import { Connect } from './pages/Connect.js';
import { Rules } from './pages/Rules.js';
import { Session } from './pages/Session.js';
import { Claude } from './pages/Claude.js';
import { Dashboard } from './pages/Dashboard.js';
import { Badge } from './pages/Badge.js';
import { Backup, Restore } from './pages/Backup.js';
import { Services } from './pages/Services.js';
import { Landing } from './pages/Landing.js';

type Route = 'connect' | 'rules' | 'session' | 'claude' | 'dashboard' | 'badge' | 'backup' | 'restore' | 'services';
const ROUTES: Route[] = ['connect', 'rules', 'session', 'claude', 'dashboard', 'badge', 'backup', 'restore', 'services'];
const STEP_ROUTE: Record<StepId, Route> = {
  connect: 'connect', login: 'connect', rules: 'rules', session: 'session', claude: 'claude', badge: 'badge', backup: 'backup', done: 'dashboard',
};
// Day-to-day places, once set up. Setup-only steps (connect, session) live on the setup track.
const TABS: { route: Route; label: string }[] = [
  { route: 'dashboard', label: 'Dashboard' },
  { route: 'services', label: 'Services' },
  { route: 'rules', label: 'Rules' },
  { route: 'claude', label: 'Agent' },
  { route: 'badge', label: 'Agent identity' },
  { route: 'backup', label: 'Backup' },
];

const routeFromHash = (): Route | null => {
  const r = location.hash.replace(/^#\//, '') as Route;
  return ROUTES.includes(r) ? r : null;
};

/** The Flex, as a mark: the device is the product's authority. */
const Mark = () => (
  <svg width="22" height="28" viewBox="0 0 22 28" aria-hidden="true">
    <rect x="1" y="1" width="20" height="26" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
    <rect x="5" y="5" width="12" height="14" rx="2" fill="currentColor" />
  </svg>
);

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
    hasBackup: bsa.hasBackup,
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

  const settingUp = !bsa.account || flow.current !== 'done';
  const showTrack = settingUp || current === 'connect' || current === 'session';
  const required = flow.steps.filter((s) => !s.optional);
  const optional = flow.steps.filter((s) => s.optional);

  return (
    <div className="app">
      <header className="topbar">
        <a className="wordmark" href="#/dashboard"><Mark /> BSA Sentry</a>
        {bsa.account && (
          <nav className="tabs" aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.route} href={`#/${t.route}`} className={current === t.route ? 'active' : ''} aria-current={current === t.route ? 'page' : undefined}>{t.label}</a>
            ))}
          </nav>
        )}
        <div className="topbar-right">
          <span className={`status is-${bsa.account ? status.level : 'warn'}`} data-testid="statusbar" role="status">
            {bsa.account ? status.text : 'Connect your Flex, then log in with Ledger'}
          </span>
          {bsa.account && <span className="account"><code>{shortAddr(bsa.account)}</code></span>}
          {bsa.account && <button className="ghost small" onClick={() => void bsa.logout()}>Log out</button>}
        </div>
      </header>

      {(bsa.busy || bsa.prompt || bsa.error) && (
        <div className="notices">
          {bsa.busy && <div className="device-prompt" data-testid="device-prompt"><span className="pulse" /> {bsa.busy}</div>}
          {bsa.prompt && (
            <div className="device-prompt" data-testid="user-step">
              <span className="pulse" /> {bsa.prompt.text}
              <button className="small" onClick={bsa.prompt.resolve}>{bsa.prompt.button}</button>
            </div>
          )}
          {bsa.error && <div className="error" role="alert">{bsa.error} <button className="ghost" onClick={bsa.clearError} aria-label="Dismiss">×</button></div>}
        </div>
      )}

      {!bsa.account ? <Landing bsa={bsa} /> : (
      <div className={showTrack ? 'with-track' : 'page'}>
        {showTrack && (
          <aside className="track" aria-label="Setup">
            <h2>Set up your agent</h2>
            <ol>
              {required.map((s, i) => (
                <li key={s.id}>
                  <a href={`#/${STEP_ROUTE[s.id]}`} className={`${s.done ? 'done' : ''} ${STEP_ROUTE[s.id] === current ? 'active' : ''}`}>
                    <span className="mark" aria-hidden={!s.done}>{s.done ? '✓' : i + 1}</span> {s.label}
                  </a>
                </li>
              ))}
            </ol>
            <ol className="optional">
              {optional.map((s) => (
                <li key={s.id}>
                  <a href={`#/${STEP_ROUTE[s.id]}`} className={`${s.done ? 'done' : ''} ${STEP_ROUTE[s.id] === current ? 'active' : ''}`}>
                    <span className="mark" aria-hidden={!s.done}>{s.done ? '✓' : '+'}</span> {s.label}
                  </a>
                </li>
              ))}
            </ol>
            <a className="aside-link" href="#/restore">Restoring a reset Flex?</a>
          </aside>
        )}

        <main>
          {current === 'connect' && <Connect bsa={bsa} />}
          {current === 'rules' && <Rules bsa={bsa} />}
          {current === 'session' && <Session bsa={bsa} />}
          {current === 'claude' && <Claude bsa={bsa} />}
          {current === 'dashboard' && <Dashboard bsa={bsa} />}
          {current === 'badge' && <Badge bsa={bsa} />}
          {current === 'backup' && <Backup bsa={bsa} />}
          {current === 'restore' && <Restore bsa={bsa} />}
          {current === 'services' && <Services bsa={bsa} />}
        </main>
      </div>
      )}
    </div>
  );
}
