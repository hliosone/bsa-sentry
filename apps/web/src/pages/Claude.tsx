import { useEffect, useState } from 'react';
import type { Bsa } from '../useBsa.js';
import { api } from '../api.js';

type Grant = { id: string; client_name: string; created_at: number };

export function Claude({ bsa }: { bsa: Bsa }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [copied, setCopied] = useState(false);
  const load = () => api.grants().then((g) => setGrants(g.grants)).catch(() => setGrants([]));
  useEffect(() => { if (bsa.account) void load(); }, [bsa.account]);

  const url = bsa.config?.mcpUrl ?? '';
  return (
    <section className="card">
      <h2>Connecter Claude</h2>
      <ol className="steps-howto">
        <li>Sur <b>claude.ai</b> : Réglages → Connecteurs → <b>Ajouter un connecteur personnalisé</b>.</li>
        <li>Colle cette adresse :
          <div className="copy">
            <code data-testid="mcp-url">{url}</code>
            <button className="ghost" onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); }}>{copied ? 'Copié' : 'Copier'}</button>
          </div>
        </li>
        <li>Claude ouvre une page BSA Sentry : clique <b>« Autoriser Claude à demander des paiements à ton Flex »</b>.</li>
        <li>Demande-lui par exemple : <i>« Achète-moi un café »</i>.</li>
      </ol>
      <p>Claude peut seulement <b>demander</b>. Ton Flex signe seul ce qui respecte tes règles, te demande pour le reste, refuse ce qui est dangereux.</p>

      <h3>Accès accordés</h3>
      {grants.length === 0 ? <p className="muted">Aucun pour l'instant.</p> : (
        <ul className="grants">
          {grants.map((g) => (
            <li key={g.id}>
              <span>{g.client_name ?? 'Client'} · depuis {new Date(g.created_at * 1000).toLocaleString('fr-CH')}</span>
              <button className="danger" onClick={async () => { await api.revokeGrant(g.id); await load(); }}>Révoquer</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
