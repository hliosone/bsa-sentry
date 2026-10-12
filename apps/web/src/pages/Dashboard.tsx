import { useCallback, useEffect, useState } from 'react';
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
  const [wallets, setWallets] = useState<WalletsInfo | null>(null);
  const loadWallets = useCallback(async () => {
    const r = await fetch('/topup/wallets', { credentials: 'same-origin' }).catch(() => null);
    if (r?.ok) setWallets(await r.json());
  }, []);
  // Re-read after anything that can move money: a payment settling, the device state changing.
  useEffect(() => { if (bsa.account) void loadWallets(); }, [bsa.account, bsa.feed.items.length, d?.spent, loadWallets]);

  return (
    <>
      {bsa.feed.banner && (
        <div className="banner" role="alert" data-testid="refusal-banner">
          <b>Refused by your Flex:</b> {bsa.feed.banner.amount} USDC to {bsa.feed.banner.merchant} — {REASONS[bsa.feed.banner.reason] ?? bsa.feed.banner.reason}
          <button className="ghost" onClick={bsa.dismissBanner}>OK</button>
        </div>
      )}
      <Wallets bsa={bsa} wallets={wallets} />
      <TopUp bsa={bsa} mainUsdc={wallets?.main.usdc} onDone={() => void loadWallets()} />
      <section className="card budget">
        <h2>Spending limit</h2>
        <p className="muted">A rule on your Flex: how much the agent may spend without asking you. It is not money (the money is in the agent wallet above). Reset it on the Flex: menu → +20 USDC.</p>
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

      <section className="card">
        <h2>Emergency stop</h2>
        <p>Erases the rules and trusted merchants from the Flex. The agent cannot pay anything until you set new rules.</p>
        <button className="danger" disabled={!p?.active || !!bsa.busy} onClick={() => void bsa.clearRules()} data-testid="kill">Block the agent</button>
      </section>
    </>
  );
}

/** Moves USDC from the user's main account to the agent. The Flex picks the recipient itself. */
function TopUp({ bsa, mainUsdc, onDone }: { bsa: Bsa; mainUsdc?: string; onDone: () => void }) {
  const [amount, setAmount] = useState('5');
  const [done, setDone] = useState<{ txHash: string; amount: string } | null>(null);
  return (
    <section className="card">
      <h2>Top up the agent</h2>
      <p>Move USDC from your main account (0xMAIN) to your agent wallet (0xAGENT). Your Flex shows the amount and both full addresses, and you hold to sign. The recipient is always your own agent: the Flex fills it in itself.{mainUsdc !== undefined && <> Your main account holds <b>{mainUsdc} USDC</b>.</>}</p>
      <div className="topup">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" data-testid="topup-amount" /> USDC
        <button className="primary" disabled={!bsa.signer || !!bsa.busy} onClick={async () => { setDone(null); const r = await bsa.topUp(amount); if (r) { setDone(r); onDone(); } }} data-testid="topup">Top up from my main account</button>
      </div>
      {done && (
        <p className="ok" data-testid="topup-done">
          Topped up {done.amount} USDC{bsa.config && <> · <a href={`${bsa.config.explorer}/tx/${done.txHash}`} target="_blank" rel="noreferrer">view on Arc ↗</a></>}
        </p>
      )}
    </section>
  );
}

type WalletsInfo = { main: { address: string; usdc: string }; agent: { address: string; usdc: string } | null };

/** The real money, read from Arc by the server: the Flex has no network to show it. */
function Wallets({ bsa, wallets }: { bsa: Bsa; wallets: WalletsInfo | null }) {
  const link = (a: string) => bsa.config && <a href={`${bsa.config.explorer}/address/${a}`} target="_blank" rel="noreferrer">view on Arc ↗</a>;
  return (
    <section className="card wallets">
      <h2>Wallets</h2>
      {!wallets ? <p className="muted">Reading balances from Arc…</p> : (
        <dl className="wallet-list">
          <dt>Agent wallet (0xAGENT) — what Claude can spend</dt>
          <dd>
            {wallets.agent
              ? <><b data-testid="agent-balance">{wallets.agent.usdc} USDC</b> <code>{shortAddr(wallets.agent.address)}</code> {link(wallets.agent.address)}</>
              : <span className="muted">connect your Flex to see it</span>}
          </dd>
          <dt>Main account (0xMAIN) — yours</dt>
          <dd><b data-testid="main-balance">{wallets.main.usdc} USDC</b> <code>{shortAddr(wallets.main.address)}</code> {link(wallets.main.address)}</dd>
        </dl>
      )}
    </section>
  );
}
