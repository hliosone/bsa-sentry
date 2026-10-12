import { useState } from 'react';
import type { Bsa } from '../useBsa.js';
import { shortAddr, time, usdc } from '../format.js';

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

const STAGE: Record<string, string> = {
  pending: 'waiting for the Flex', signed: 'signed by the Flex', refused: 'refused', settled: 'paid on Arc', failed: 'failed',
};

export function Dashboard({ bsa }: { bsa: Bsa }) {
  const d = bsa.device;
  const p = d?.policy;
  const left = p ? (p.budget > d!.spent ? p.budget - d!.spent : 0n) : 0n;
  const pct = p && p.budget > 0n ? Number((left * 1000n) / p.budget) / 10 : 0;

  return (
    <>
      {bsa.feed.banner && (
        <div className="banner" role="alert" data-testid="refusal-banner">
          <b>Refused by your Flex:</b> {bsa.feed.banner.amount} USDC to {bsa.feed.banner.merchant} — {REASONS[bsa.feed.banner.reason] ?? bsa.feed.banner.reason}
          <button className="ghost" onClick={bsa.dismissBanner}>OK</button>
        </div>
      )}
      <section className="card budget">
        <h2>Agent budget</h2>
        {p?.active ? (
          <>
            <div className="big" data-testid="budget-left">{usdc(left)} <small>/ {usdc(p.budget)} USDC</small></div>
            <div className="gauge"><div style={{ width: `${pct}%` }} /></div>
            <p className="muted">{d!.count} payment{d!.count === 1 ? '' : 's'} · automatic up to {usdc(p.autoMax)} USDC · never above {usdc(p.hardMax)} USDC</p>
            {d!.lastPayment && <p>Last: <b>{d!.lastPayment.label}</b> {usdc(d!.lastPayment.value)} USDC</p>}
          </>
        ) : <p className="muted">No active rules on the Flex.</p>}
      </section>

      <section className="card">
        <h2>Live</h2>
        {bsa.feed.items.length === 0 ? <p className="muted">Claude's requests will show up here.</p> : (
          <ul className="feed" data-testid="feed">
            {bsa.feed.items.map((i) => (
              <li key={i.id} className={`stage-${i.stage}`}>
                <span className="when">{time(i.at)}</span>
                <div className="body">
                  <div className="what"><b>{i.amount} USDC</b> · {i.merchant} <code>{shortAddr(i.payee)}</code></div>
                  <div className="stage">{STAGE[i.stage]}{i.reason ? ` — ${REASONS[i.reason] ?? i.reason}` : ''}</div>
                </div>
                {i.txHash && bsa.config && <a href={`${bsa.config.explorer}/tx/${i.txHash}`} target="_blank" rel="noreferrer">view on Arc ↗</a>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <TopUp bsa={bsa} />
      <section className="card">
        <h2>Emergency stop</h2>
        <p>Erases the rules and trusted merchants from the Flex. The agent cannot pay anything until you set new rules.</p>
        <button className="danger" disabled={!p?.active || !!bsa.busy} onClick={() => void bsa.clearRules()} data-testid="kill">Block the agent</button>
      </section>
    </>
  );
}

/** Moves USDC from the user's main account to the agent. The Flex picks the recipient itself. */
function TopUp({ bsa }: { bsa: Bsa }) {
  const [amount, setAmount] = useState('20');
  const [done, setDone] = useState<{ txHash: string; amount: string } | null>(null);
  return (
    <section className="card">
      <h2>Top up the agent</h2>
      <p>Move USDC from your main account (0xMAIN) to your agent (0xAGENT). Your Flex shows the amount and both full addresses, and you hold to sign. The recipient is always your own agent: the Flex fills it in itself.</p>
      <div className="topup">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" data-testid="topup-amount" /> USDC
        <button className="primary" disabled={!bsa.signer || !!bsa.busy} onClick={async () => { setDone(null); const r = await bsa.topUp(amount); if (r) setDone(r); }} data-testid="topup">Top up from my main account</button>
      </div>
      {done && (
        <p className="ok" data-testid="topup-done">
          Topped up {done.amount} USDC{bsa.config && <> · <a href={`${bsa.config.explorer}/tx/${done.txHash}`} target="_blank" rel="noreferrer">view on Arc ↗</a></>}
        </p>
      )}
    </section>
  );
}
