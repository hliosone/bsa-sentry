import type { Bsa } from '../useBsa.js';
import { shortAddr, time, usdc } from '../format.js';

const REASONS: Record<string, string> = {
  OVER_HARD_MAX: 'au-dessus de ton plafond absolu — refusé sans même te demander',
  USER_REJECTED: 'tu as refusé sur le Flex (ou 60 s sans réponse)',
  NO_SESSION: "l'agent n'était pas démarré sur le Flex",
  NO_POLICY: 'aucune règle sur le Flex',
  WRONG_CHAIN_OR_TOKEN: 'mauvais réseau ou mauvais jeton',
  TIMEOUT: 'le Flex n\'a pas répondu à temps',
  FLEX_LOCKED: 'Flex verrouillé',
  APP_CLOSED: "l'app BSA Sentry n'était pas ouverte",
  DISCONNECTED: 'onglet ou Flex déconnecté',
};

const STAGE: Record<string, string> = {
  pending: 'en attente du Flex', signed: 'signé par le Flex', refused: 'refusé', settled: 'payé sur Arc', failed: 'échec',
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
          <b>Refusé par ton Flex :</b> {bsa.feed.banner.amount} USDC à {bsa.feed.banner.merchant} — {REASONS[bsa.feed.banner.reason] ?? bsa.feed.banner.reason}
          <button className="ghost" onClick={bsa.dismissBanner}>OK</button>
        </div>
      )}
      <section className="card budget">
        <h2>Budget de l'agent</h2>
        {p?.active ? (
          <>
            <div className="big" data-testid="budget-left">{usdc(left)} <small>/ {usdc(p.budget)} USDC</small></div>
            <div className="gauge"><div style={{ width: `${pct}%` }} /></div>
            <p className="muted">{d!.count} paiement{d!.count === 1 ? '' : 's'} · automatique jusqu'à {usdc(p.autoMax)} USDC · jamais au-dessus de {usdc(p.hardMax)} USDC</p>
            {d!.lastPayment && <p>Dernier : <b>{d!.lastPayment.label}</b> {usdc(d!.lastPayment.value)} USDC</p>}
          </>
        ) : <p className="muted">Aucune règle active sur le Flex.</p>}
      </section>

      <section className="card">
        <h2>En direct</h2>
        {bsa.feed.items.length === 0 ? <p className="muted">Les demandes de Claude apparaîtront ici.</p> : (
          <ul className="feed" data-testid="feed">
            {bsa.feed.items.map((i) => (
              <li key={i.id} className={`stage-${i.stage}`}>
                <span className="when">{time(i.at)}</span>
                <div className="body">
                  <div className="what"><b>{i.amount} USDC</b> · {i.merchant} <code>{shortAddr(i.payee)}</code></div>
                  <div className="stage">{STAGE[i.stage]}{i.reason ? ` — ${REASONS[i.reason] ?? i.reason}` : ''}</div>
                </div>
                {i.txHash && bsa.config && <a href={`${bsa.config.explorer}/tx/${i.txHash}`} target="_blank" rel="noreferrer">voir sur Arc ↗</a>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Arrêt d'urgence</h2>
        <p>Efface les règles et les marchands de confiance du Flex. L'agent ne pourra plus rien payer jusqu'à de nouvelles règles.</p>
        <button className="danger" disabled={!p?.active || !!bsa.busy} onClick={() => void bsa.clearRules()} data-testid="kill">Bloquer l'agent</button>
      </section>
    </>
  );
}
