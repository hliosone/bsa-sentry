import { useCallback, useEffect, useState } from 'react';
import type { Credentials } from '@bsa-sentry/types';
import type { Bsa } from '../useBsa.js';
import { shortAddr, usdc } from '../format.js';
import { activityRows, whenText, type ChainTransfer } from '../state/activity.js';
import { describeRight } from './Badge.js';
import { FlexView, type ScreenLines } from '../components/FlexView.js';

// Why the Flex refused, in the user's words.
const REASONS: Record<string, string> = {
  OVER_HARD_MAX: 'above your hard limit, refused without asking you',
  USER_REJECTED: 'you rejected it on the Flex (or 60 s without an answer)',
  NO_SESSION: 'the agent was not started on the Flex',
  NO_POLICY: 'no rules on the Flex',
  WRONG_CHAIN_OR_TOKEN: 'wrong network or wrong token',
  TIMEOUT: 'the Flex did not answer in time',
  FLEX_LOCKED: 'Flex locked',
  APP_CLOSED: 'the BSA Sentry app was not open',
  DISCONNECTED: 'tab or Flex disconnected',
};

type WalletsInfo = { main: { address: string; usdc: string }; agent: { address: string; usdc: string } | null };

/** "17.00": the device shows the spending limit with cents, so the replica does too. */
const cents = (units: bigint) => `${units / 1_000_000n}.${((units % 1_000_000n) / 10_000n).toString().padStart(2, '0')}`;

export function Dashboard({ bsa }: { bsa: Bsa }) {
  const d = bsa.device;
  const p = d?.policy;
  const left = p ? (p.budget > d!.spent ? p.budget - d!.spent : 0n) : 0n;
  const pct = p && p.budget > 0n ? Number((left * 1000n) / p.budget) / 10 : 0;
  const armed = !!d?.sessionArmed || bsa.bridgeStatus.session;
  const explorer = bsa.config?.explorer;

  const [wallets, setWallets] = useState<WalletsInfo | null>(null);
  const loadWallets = useCallback(async () => {
    const r = await fetch('/topup/wallets', { credentials: 'same-origin' }).catch(() => null);
    if (r?.ok) setWallets(await r.json());
  }, []);
  // The agent wallet's history, from the chain: payments and top-ups, even from before this tab.
  const [transfers, setTransfers] = useState<ChainTransfer[]>([]);
  const loadHistory = useCallback(async () => {
    const r = await fetch('/activity/chain', { credentials: 'same-origin' }).catch(() => null);
    if (r?.ok) setTransfers((await r.json()).transfers ?? []);
  }, []);
  // Re-read after anything that can move money: a payment settling, the device state changing.
  const settledCount = bsa.feed.items.filter((i) => i.stage === 'settled').length;
  // bsa.serverAgent: the agent balance can only be read once the bridge told the server its address.
  useEffect(() => { if (bsa.account) void loadWallets(); }, [bsa.account, bsa.serverAgent, bsa.feed.items.length, d?.spent, loadWallets]);
  useEffect(() => { if (bsa.account) void loadHistory(); }, [bsa.account, settledCount, d?.spent, wallets?.agent?.address, loadHistory]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);

  // The rights the agent holds, read from the Flex itself.
  const [held, setHeld] = useState<Credentials | null>(null);
  useEffect(() => {
    if (!bsa.signer || !d?.hasCredentials) { setHeld(null); return; }
    void bsa.onDevice((s) => s.getCredentials()).then((c) => setHeld((c as Credentials) ?? null)).catch(() => setHeld(null));
  }, [bsa.signer, d?.hasCredentials]);

  const labels: Record<string, string> = {};
  // The demo merchants' own names win over a label clipped on the Flex ("BSA Shop - Arc R").
  for (const m of [...(bsa.config?.defaultPayees ?? []), ...(p?.payees ?? []), ...(bsa.config?.merchants ?? [])]) labels[m.address.toLowerCase()] = m.label;
  const rows = activityRows(bsa.feed.items, transfers, { agent: wallets?.agent?.address, main: wallets?.main.address, labels, reasons: REASONS });

  const screen: ScreenLines = {
    title: 'BSA Sentry',
    lines: p?.active
      ? [
          ...(held ? [`Agent: ${held.delegation.agentName}`] : []),
          `Limit left ${cents(left)} USDC`,
          ...(d!.lastPayment ? [`Last: ${d!.lastPayment.label} ${usdc(d!.lastPayment.value)} USDC`] : []),
          `Arc testnet . session ${armed ? 'on' : 'off'}`,
        ]
      : ['No rules yet:', 'set them on the website', `session ${armed ? 'on' : 'off'}`],
  };

  return (
    <>
      {bsa.feed.banner && (
        <div className="banner" role="alert" data-testid="refusal-banner">
          <span><b>Refused by your Flex:</b> {bsa.feed.banner.amount} USDC to {bsa.feed.banner.merchant}: {REASONS[bsa.feed.banner.reason] ?? bsa.feed.banner.reason}</span>
          <button className="ghost" onClick={bsa.dismissBanner}>OK</button>
        </div>
      )}

      <div className="bento">
        <section className="tile stage" aria-label="Your Flex">
          <div className="stage-view">
            <FlexView screen={screen} />
          </div>
          <div className="stage-caption">
            <b>Enforced by your Flex</b>
            <span>Every payment is decided on the device. This page only shows what it holds. Drag to turn it.</span>
          </div>
        </section>

        <section className="tile wallet">
          <h2>Agent wallet</h2>
          <div className="figure" data-testid="agent-balance">{wallets?.agent ? wallets.agent.usdc : '…'}<small>USDC</small></div>
          <p className="sub">
            What your agent can spend, on Arc testnet.{' '}
            {wallets?.agent && <><code>{shortAddr(wallets.agent.address)}</code> {explorer && <a href={`${explorer}/address/${wallets.agent.address}`} target="_blank" rel="noreferrer">View on Arc</a>}</>}
            {wallets && !wallets.agent && 'Connect your Flex to see it.'}
          </p>
          <TopUp bsa={bsa} mainUsdc={wallets?.main.usdc} onDone={() => void loadWallets()} />
        </section>

        <section className="tile activity">
          <div className="tile-head">
            <h2>Activity</h2>
            {wallets?.agent && explorer && <a className="sub" href={`${explorer}/address/${wallets.agent.address}`} target="_blank" rel="noreferrer">All agent transactions on Arc</a>}
          </div>
          {rows.length === 0 ? (
            <p className="empty">Nothing yet. When your agent pays a merchant, or you top it up, it shows up here with what your Flex decided.</p>
          ) : (
            <ul className="ledger" data-testid="feed">
              {rows.map((r) => (
                <li key={r.key} className={`kind-${r.kind}`}>
                  <span className="ledger-mark" aria-hidden="true" />
                  <div className="ledger-what">
                    <b>{r.title}</b>
                    <span className="ledger-meta">
                      <span>{whenText(r.at)}</span>
                      {r.detail && <span>{r.detail}</span>}
                      {r.txHash && explorer && <a href={`${explorer}/tx/${r.txHash}`} target="_blank" rel="noreferrer">View on Arc</a>}
                    </span>
                  </div>
                  <span className="ledger-sum">{r.sign === '-' ? '\u2212' : r.sign}{r.amount} <small>USDC</small></span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="tile limit">
          <h2>Spending limit</h2>
          {p?.active ? (
            <>
              <div className="figure small-figure"><span data-testid="budget-left">{usdc(left)}</span><small>of {usdc(p.budget)} USDC</small></div>
              <div className={`gauge ${pct < 25 ? 'low' : ''}`} role="img" aria-label={`${pct}% of the spending limit left`}><div style={{ width: `${pct}%` }} /></div>
              <p className="sub">Left to spend without asking you. A rule on your Flex, not money: reset it from the app menu (+20 USDC).</p>
            </>
          ) : <p className="sub">No rules on the Flex yet. <a href="#/rules">Set your rules</a>.</p>}
        </section>

        <section className={`tile session ${armed ? 'is-on' : 'is-off'}`}>
          <h2>Agent session</h2>
          <div className="session-state">{armed ? 'On' : 'Off'}</div>
          <p className="sub">{armed
            ? 'Your agent can ask your Flex to pay. Quitting the app turns it off.'
            : 'Turn it on from your Flex: gear icon, then Agent session. Only the device can do it.'}</p>
        </section>

        <section className="tile identity">
          <h2>Agent identity</h2>
          {held ? (
            <div className="chips">
              {held.delegation.claims.map((c) => {
                const r = describeRight(c);
                return <span className="chip" key={c} title={r.detail}><i aria-hidden="true">{r.mark}</i>{r.title}</span>;
              })}
            </div>
          ) : <p className="sub">Your agent proves nothing about you yet.</p>}
          <a className="tile-link" href="#/badge">{held ? 'Manage rights' : 'Grant 18+ or jurisdiction'}</a>
        </section>

        <section className="tile main">
          <h2>Main account</h2>
          <div className="figure small-figure" data-testid="main-balance">{wallets ? wallets.main.usdc : '…'}<small>USDC</small></div>
          <p className="sub">Yours. Top-ups come from here.{wallets && <> <code>{shortAddr(wallets.main.address)}</code></>}</p>
        </section>


        <section className="tile rules-tile">
          <h2>Rules on your Flex</h2>
          {p?.active ? (
            <ul className="mirror-rules">
              <li><span>Paid without asking</span><span>up to {usdc(p.autoMax)} USDC</span></li>
              <li><span>Never paid</span><span>above {usdc(p.hardMax)} USDC</span></li>
              <li><span>Payments before asking</span><span>{d!.count} of {p.maxCount}</span></li>
              <li><span>Trusted merchants</span><span>{p.payees.length ? p.payees.map((m) => m.label).join(', ') : 'none'}</span></li>
            </ul>
          ) : <p className="sub">None yet.</p>}
          <div className="mirror-actions">
            <a href="#/rules"><button className="small">Edit rules</button></a>
            <button className="danger small" disabled={!p?.active || !!bsa.busy} onClick={() => void bsa.clearRules()} data-testid="kill">Block the agent</button>
          </div>
        </section>
      </div>
    </>
  );
}

/** Moves USDC from the user's main account to the agent. The Flex picks the recipient itself. */
function TopUp({ bsa, mainUsdc, onDone }: { bsa: Bsa; mainUsdc?: string; onDone: () => void }) {
  const [amount, setAmount] = useState('5');
  const [done, setDone] = useState<{ txHash: string; amount: string } | null>(null);
  return (
    <div className="topup-row">
      <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" data-testid="topup-amount" />
      <button className="primary" disabled={!bsa.signer || !!bsa.busy} data-testid="topup"
        onClick={async () => { setDone(null); const r = await bsa.topUp(amount); if (r) { setDone(r); onDone(); } }}>
        Top up from main account
      </button>
      {done ? (
        <span className="done" data-testid="topup-done">
          Topped up {done.amount} USDC.{' '}
          {bsa.config && <a href={`${bsa.config.explorer}/tx/${done.txHash}`} target="_blank" rel="noreferrer">View transaction</a>}
        </span>
      ) : (
        <span className="sub">{mainUsdc !== undefined ? `${mainUsdc} USDC available. ` : ''}Your Flex shows both addresses before you sign.</span>
      )}
    </div>
  );
}
