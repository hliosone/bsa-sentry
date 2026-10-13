// The agent wallet as a statement: what it spent, per category and per payment, over a period,
// and an ISO 20022 camt.053 export of that period for an accountant. Read from the chain, so it
// is complete even for payments made while this site was closed.
import { useEffect, useState } from 'react';
import type { Bsa } from '../useBsa.js';
import { shortAddr } from '../format.js';
import type { ChainTransfer } from '../state/activity.js';
import { byCategory, camt053, periodRange, statementEntries, totals, type Period } from '../state/statement.js';
import './spending.css';

type WalletsInfo = { main: { address: string; usdc: string }; agent: { address: string; usdc: string } | null };

const PERIODS: { id: Period; label: string }[] = [
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
];

/** "3.50" from USDC base units. */
const money = (units: bigint) => `${units / 1_000_000n}.${((units % 1_000_000n) / 10_000n).toString().padStart(2, '0')}`;
/** USDC base units from the server's "12.4". */
const toUnits = (s: string) => {
  const [w = '0', f = ''] = s.split('.');
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0').slice(0, 6));
};
const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Spending({ bsa }: { bsa: Bsa }) {
  const explorer = bsa.config?.explorer;
  const [period, setPeriod] = useState<Period>('month');
  const [wallets, setWallets] = useState<WalletsInfo | null>(null);
  const [transfers, setTransfers] = useState<ChainTransfer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settled = bsa.feed.items.filter((i) => i.stage === 'settled').length;
  useEffect(() => {
    if (!bsa.account) return;
    void (async () => {
      const [w, h] = await Promise.all([
        fetch('/topup/wallets', { credentials: 'same-origin' }).catch(() => null),
        fetch('/activity/chain', { credentials: 'same-origin' }).catch(() => null),
      ]);
      if (w?.ok) setWallets(await w.json());
      if (h?.ok) { setTransfers((await h.json()).transfers ?? []); setError(null); } else setError('Could not read the agent wallet history from the Arc explorer. Try again in a moment.');
    })();
  }, [bsa.account, bsa.serverAgent, settled]);

  const all = statementEntries(transfers ?? [], { agent: wallets?.agent?.address, main: wallets?.main.address, merchants: bsa.config?.merchants ?? [] });
  const range = periodRange(period);
  const entries = all.filter((e) => e.at >= range.from && e.at <= range.to);
  const sum = totals(entries);
  const cats = byCategory(entries);
  const top = cats[0]?.units ?? 0n;

  const exportCamt = () => {
    if (!wallets?.agent || !bsa.config) return;
    const now = Date.now();
    const from = period === 'all' && entries.length ? Math.min(...entries.map((e) => e.at)) : range.from;
    const xml = camt053({
      account: wallets.agent.address, entries, from, to: now, closing: toUnits(wallets.agent.usdc), now,
      network: bsa.config.chainName, chainId: bsa.config.chainId,
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    a.download = `bsa-sentry-camt053-${new Date(from).toISOString().slice(0, 10)}-${new Date(now).toISOString().slice(0, 10)}.xml`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="spending">
      <header className="sp-head">
        <div>
          <h1>Spending</h1>
          <p className="sub">What your agent paid from its wallet, read from Arc testnet.{wallets?.agent && <> <code>{shortAddr(wallets.agent.address)}</code></>}</p>
        </div>
        <div className="sp-periods" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.id} className={`small ${period === p.id ? 'is-on' : 'ghost'}`} aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</button>
          ))}
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="sp-figures" aria-label="Totals">
        <div><span>Spent</span><b data-testid="sp-spent">{money(sum.spent)}</b><small>USDC</small></div>
        <div><span>Payments</span><b>{sum.payments}</b></div>
        <div><span>Top-ups received</span><b className="is-in">{money(sum.received)}</b><small>USDC</small></div>
        <div><span>Balance now</span><b>{wallets?.agent ? money(toUnits(wallets.agent.usdc)) : '…'}</b><small>USDC</small></div>
      </section>

      <div className="sp-grid">
        <section className="tile sp-cats">
          <h2>By category</h2>
          {cats.length === 0 ? <p className="sub">No payments in this period.</p> : (
            <ul>
              {cats.map((c) => (
                <li key={c.category}>
                  <div className="sp-cat-row"><b>{c.category}</b><span>{money(c.units)} USDC</span></div>
                  <div className="sp-bar" aria-hidden="true"><div style={{ width: `${top > 0n ? Number((c.units * 1000n) / top) / 10 : 0}%` }} /></div>
                  <span className="sub">{c.count} {c.count === 1 ? 'payment' : 'payments'}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="sp-export">
            <h2>Export for your accountant</h2>
            <p className="sub">An ISO 20022 bank statement (camt.053.001.02) of this period: every payment and top-up, with its category and Arc transaction. Amounts in USD at 1 USDC = 1 USD.</p>
            <button className="primary" onClick={exportCamt} disabled={!wallets?.agent || transfers === null} data-testid="export-camt">Download ISO 20022 statement</button>
          </div>
        </section>

        <section className="tile sp-txs">
          <h2>Transactions</h2>
          {transfers === null ? <p className="sub">Reading the Arc explorer…</p> : entries.length === 0 ? (
            <p className="empty">Nothing in this period. Payments your agent makes, and your top-ups, show up here.</p>
          ) : (
            <table>
              <thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.txHash + e.counterparty} className={e.direction === 'credit' ? 'is-in' : ''}>
                    <td>{when(e.at)}</td>
                    <td>{e.name}{explorer && <> <a href={`${explorer}/tx/${e.txHash}`} target="_blank" rel="noreferrer">View on Arc</a></>}</td>
                    <td>{e.category}</td>
                    <td className="num">{e.direction === 'debit' ? '−' : '+'}{money(e.units)} <small>USDC</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
