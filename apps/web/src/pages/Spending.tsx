// The agent wallet as a statement: what it spent, per category and per payment, over a period,
// and an ISO 20022 camt.053 export of that period for an accountant. Read from the chain, so it
// is complete even for payments made while this site was closed.
import { useEffect, useState } from 'react';
import type { Bsa } from '../useBsa.js';
import { shortAddr } from '../format.js';
import type { ChainTransfer } from '../state/activity.js';
import { balanceAt, byCategory, camt053, periodRange, statementEntries, totals, type Period } from '../state/statement.js';
import './spending.css';

type WalletsInfo = { main: { address: string; usdc: string }; agent: { address: string; usdc: string } | null };

const PERIODS: { id: Period; label: string }[] = [
  { id: 'month', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
];
type Kind = 'all' | 'debit' | 'credit';
const KINDS: { id: Kind; label: string }[] = [{ id: 'all', label: 'Everything' }, { id: 'debit', label: 'Money out' }, { id: 'credit', label: 'Money in' }];

/** "2026-10-13" in local time, for a date input. */
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

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
  const [period, setPeriod] = useState<Period | 'custom'>('month');
  const [fromDay, setFromDay] = useState(() => ymd(periodRange('month').from));
  const [toDay, setToDay] = useState(() => ymd(Date.now()));
  const [kind, setKind] = useState<Kind>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const preset = (p: Period, all: { at: number }[]) => {
    const r = periodRange(p);
    setPeriod(p);
    setFromDay(ymd(p === 'all' && all.length ? Math.min(...all.map((e) => e.at)) : r.from));
    setToDay(ymd(r.to));
  };
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
  // The chosen days, in local time, whole days; never past now.
  const from = new Date(`${fromDay}T00:00:00`).getTime() || 0;
  const to = Math.min(new Date(`${toDay}T23:59:59.999`).getTime() || Date.now(), Date.now());
  const inRange = all.filter((e) => e.at >= from && e.at <= to);
  const categories = [...new Set(inRange.map((e) => e.category))];
  const chosen = picked.filter((c) => categories.includes(c));
  const entries = inRange.filter((e) => (kind === 'all' || e.direction === kind) && (chosen.length === 0 || chosen.includes(e.category)));
  const filtered = kind !== 'all' || chosen.length > 0;
  const sum = totals(entries);
  const cats = byCategory(entries);
  const top = cats[0]?.units ?? 0n;
  const toggle = (c: string) => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  const exportCamt = () => {
    if (!wallets?.agent || !bsa.config) return;
    const current = toUnits(wallets.agent.usdc);
    const xml = camt053({
      account: wallets.agent.address, entries, from, to, now: Date.now(),
      opening: balanceAt(all, current, from - 1), closing: balanceAt(all, current, to),
      network: bsa.config.chainName, chainId: bsa.config.chainId,
      ...(filtered ? { filter: [KINDS.find((k) => k.id === kind)!.label, ...chosen].filter((x) => x !== 'Everything').join(', ') } : {}),
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    a.download = `bsa-sentry-camt053-${fromDay}-${toDay}${filtered ? '-filtered' : ''}.xml`;
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
      </header>

      <section className="sp-filters" aria-label="Filters">
        <div className="sp-filter">
          <span>Period</span>
          <div className="sp-seg" role="group" aria-label="Period">
            {PERIODS.map((p) => (
              <button key={p.id} className={`small ${period === p.id ? 'is-on' : 'ghost'}`} aria-pressed={period === p.id} onClick={() => preset(p.id, all)}>{p.label}</button>
            ))}
          </div>
          <label className="sp-date">From <input type="date" value={fromDay} max={toDay} onChange={(e) => { setFromDay(e.target.value); setPeriod('custom'); }} data-testid="sp-from" /></label>
          <label className="sp-date">To <input type="date" value={toDay} min={fromDay} max={ymd(Date.now())} onChange={(e) => { setToDay(e.target.value); setPeriod('custom'); }} data-testid="sp-to" /></label>
        </div>
        <div className="sp-filter">
          <span>Show</span>
          <div className="sp-seg" role="group" aria-label="Direction">
            {KINDS.map((k) => (
              <button key={k.id} className={`small ${kind === k.id ? 'is-on' : 'ghost'}`} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</button>
            ))}
          </div>
          {categories.length > 0 && (
            <div className="sp-cats-pick" role="group" aria-label="Categories">
              {categories.map((c) => (
                <button key={c} className={`small ${chosen.includes(c) ? 'is-on' : ''}`} aria-pressed={chosen.includes(c)} onClick={() => toggle(c)}>{c}</button>
              ))}
              {chosen.length > 0 && <button className="small ghost" onClick={() => setPicked([])}>All categories</button>}
            </div>
          )}
        </div>
      </section>

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
          {cats.length === 0 ? <p className="sub">No payments match.</p> : (
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
            <p className="sub">An ISO 20022 bank statement (camt.053.001.02) of what the list shows: {entries.length} {entries.length === 1 ? 'entry' : 'entries'} from {when(from).split(',')[0]} to {when(to).split(',')[0]}{filtered ? ', filtered' : ''}, each with its category and Arc transaction. Amounts in USD at 1 USDC = 1 USD.</p>
            <button className="primary" onClick={exportCamt} disabled={!wallets?.agent || transfers === null || entries.length === 0} data-testid="export-camt">Download ISO 20022 statement</button>
          </div>
        </section>

        <section className="tile sp-txs">
          <h2>Transactions</h2>
          {transfers === null ? <p className="sub">Reading the Arc explorer…</p> : entries.length === 0 ? (
            <p className="empty">Nothing matches these filters. Payments your agent makes, and your top-ups, show up here.</p>
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
