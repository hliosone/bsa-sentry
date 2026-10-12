import { useCallback, useEffect, useState } from 'react';
import type { Bsa } from '../useBsa.js';
import { shortAddr, time, usdc } from '../format.js';

// Why the Flex refused, in the user's words.
const REASONS: Record<string, string> = {
  OVER_HARD_MAX: 'above your hard limit — refused without even asking you',
  USER_REJECTED: 'you rejected it on the Flex (or 60 s without an answer)',
  NO_SESSION: 'the agent was not started on the Flex',
  NO_POLICY: 'no rules on the Flex',
  WRONG_CHAIN_OR_TOKEN: 'wrong network or wrong token',
  TIMEOUT: 'the Flex did not answer in time',
  FLEX_LOCKED: 'Flex locked',
  APP_CLOSED: 'the BSA Sentry app was not open',
  DISCONNECTED: 'tab or Flex disconnected',
};
const OUTCOME: Record<string, string> = {
  pending: 'Waiting for your Flex', signed: 'Signed', refused: 'Refused', settled: 'Paid', failed: 'Failed',
};

type WalletsInfo = { main: { address: string; usdc: string }; agent: { address: string; usdc: string } | null };

/** "17.00": the device shows the spending limit with cents, so the mirror does too. */
const cents = (units: bigint) => `${units / 1_000_000n}.${((units % 1_000_000n) / 10_000n).toString().padStart(2, '0')}`;

export function Dashboard({ bsa }: { bsa: Bsa }) {
  const d = bsa.device;
  const p = d?.policy;
  const left = p ? (p.budget > d!.spent ? p.budget - d!.spent : 0n) : 0n;
  const pct = p && p.budget > 0n ? Number((left * 1000n) / p.budget) / 10 : 0;
  const [wallets, setWallets] = useState<WalletsInfo | null>(null);
  const loadWallets = useCallback(async () => {
    const r = await fetch('/topup/wallets', { credentials: 'same-origin' }).catch(() => null);
    if (r?.ok) setWallets(await r.json());
  }, []);
  // Re-read after anything that can move money: a payment settling, the device state changing.
  useEffect(() => { if (bsa.account) void loadWallets(); }, [bsa.account, bsa.feed.items.length, d?.spent, loadWallets]);
  const explorer = bsa.config?.explorer;

  return (
    <>
      {bsa.feed.banner && (
        <div className="banner" role="alert" data-testid="refusal-banner">
          <span><b>Refused by your Flex:</b> {bsa.feed.banner.amount} USDC to {bsa.feed.banner.merchant} — {REASONS[bsa.feed.banner.reason] ?? bsa.feed.banner.reason}</span>
          <button className="ghost" onClick={bsa.dismissBanner}>OK</button>
        </div>
      )}

      <div className="overview">
        <section className="sheet">
          <div className="statement-head">
            <h2>Wallets</h2>
            <span className="muted">Balances on Arc testnet</span>
          </div>

          <div className="line primary-line">
            <div className="line-name">Agent wallet</div>
            <div className="amount" data-testid="agent-balance">{wallets?.agent ? wallets.agent.usdc : '…'}<small>USDC</small></div>
            <div className="line-sub">
              What Claude can spend.{' '}
              {wallets?.agent && <><code>{shortAddr(wallets.agent.address)}</code> {explorer && <a href={`${explorer}/address/${wallets.agent.address}`} target="_blank" rel="noreferrer">View on Arc</a>}</>}
              {wallets && !wallets.agent && 'Connect your Flex to see it.'}
            </div>
            <TopUp bsa={bsa} mainUsdc={wallets?.main.usdc} onDone={() => void loadWallets()} />
          </div>

          <div className="line">
            <div className="line-name">Main account</div>
            <div className="amount" data-testid="main-balance">{wallets ? wallets.main.usdc : '…'}<small>USDC</small></div>
            <div className="line-sub">
              Yours. Top-ups to the agent come from here.{' '}
              {wallets && <><code>{shortAddr(wallets.main.address)}</code> {explorer && <a href={`${explorer}/address/${wallets.main.address}`} target="_blank" rel="noreferrer">View on Arc</a>}</>}
            </div>
          </div>

          <div className="limit">
            <h2>Spending limit</h2>
            {p?.active ? (
              <>
                <div className="limit-figure">
                  <b data-testid="budget-left">{usdc(left)}</b>
                  <span className="muted">of {usdc(p.budget)} USDC left to spend without asking you</span>
                </div>
                <div className={`gauge ${pct < 25 ? 'low' : ''}`} role="img" aria-label={`${pct}% of the spending limit left`}><div style={{ width: `${pct}%` }} /></div>
                <p>A rule kept on your Flex, not money. {d!.count} payment{d!.count === 1 ? '' : 's'} so far. Reset it on the Flex from the app menu (+20 USDC).</p>
              </>
            ) : <p>No active rules on the Flex. <a href="#/rules">Set your rules</a> to let the agent spend.</p>}
          </div>
        </section>

        <aside className="mirror" aria-label="What your Flex enforces">
          <div className="flex-device">
            <div className="flex-screen" data-testid="flex-mirror">
              <div className="crest" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 2 3 5v5c0 4 3 7 7 8 4-1 7-4 7-8V5l-7-3Z" fill="none" stroke="#000" strokeWidth="1.8" /></svg>
              </div>
              <div className="app">BSA Sentry</div>
              {p?.active ? (
                <>
                  <div className="tag">Budget {cents(left)} / {cents(p.budget)} USDC</div>
                  {d!.lastPayment && <div className="tag">Last: {d!.lastPayment.label} {usdc(d!.lastPayment.value)} USDC</div>}
                  <div className="tag">Arc testnet . session {d!.sessionArmed || bsa.bridgeStatus.session ? 'on' : 'off'}</div>
                </>
              ) : (
                <>
                  <div className="tag">No rules yet:</div>
                  <div className="tag">set them on the website</div>
                </>
              )}
              <div className="quit">Quit app</div>
            </div>
          </div>
          <p className="mirror-caption">Your Flex's home screen. The rules below live on the device: this page only shows them.</p>
          {p?.active && (
            <ul className="mirror-rules">
              <li><span>Paid without asking</span><span>up to {usdc(p.autoMax)} USDC</span></li>
              <li><span>Hard limit, never paid</span><span>above {usdc(p.hardMax)} USDC</span></li>
              <li><span>Trusted merchants</span><span>{p.payees.length ? p.payees.map((m) => m.label).join(', ') : 'none'}</span></li>
              <li><span>Payments before asking</span><span>{d!.count} of {p.maxCount}</span></li>
            </ul>
          )}
          <div className="mirror-actions">
            <a href="#/rules"><button className="small">Edit rules</button></a>
            <button className="danger small" disabled={!p?.active || !!bsa.busy} onClick={() => void bsa.clearRules()} data-testid="kill">Block the agent</button>
          </div>
        </aside>
      </div>

      <section className="sheet activity">
        <div className="statement-head">
          <h2>Activity</h2>
          <span className="muted">Every request Claude sends to your Flex</span>
        </div>
        {bsa.feed.items.length === 0 ? (
          <p className="empty">Nothing yet. When Claude asks your Flex to pay, it shows up here, with what the Flex decided.</p>
        ) : (
          <ul className="feed" data-testid="feed">
            {bsa.feed.items.map((i) => (
              <li key={i.id} className={`stage-${i.stage}`}>
                <span className="when">{time(i.at)}</span>
                <span className="what">{i.merchant}<code>{shortAddr(i.payee)}</code></span>
                <span className="sum">{i.amount} USDC</span>
                <span className="outcome">{OUTCOME[i.stage]}</span>
                {(i.reason || (i.txHash && explorer)) && (
                  <span className="note">
                    {i.reason ? (REASONS[i.reason] ?? i.reason) : null}
                    {i.txHash && explorer && <a href={`${explorer}/tx/${i.txHash}`} target="_blank" rel="noreferrer">View transaction on Arc</a>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Moves USDC from the user's main account to the agent. The Flex picks the recipient itself. */
function TopUp({ bsa, mainUsdc, onDone }: { bsa: Bsa; mainUsdc?: string; onDone: () => void }) {
  const [amount, setAmount] = useState('5');
  const [done, setDone] = useState<{ txHash: string; amount: string } | null>(null);
  return (
    <div className="line-actions">
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
        <span className="muted">{mainUsdc !== undefined ? `${mainUsdc} USDC available. ` : ''}Your Flex shows both addresses before you sign.</span>
      )}
    </div>
  );
}
