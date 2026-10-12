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
      <h2>Connect Claude</h2>
      <ol className="steps-howto">
        <li>In <b>Claude</b> (claude.ai or Claude Desktop): Settings → Connectors → <b>Add custom connector</b>.</li>
        <li>Paste this URL:
          <div className="copy">
            <code data-testid="mcp-url">{url}</code>
            <button className="ghost" onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </li>
        <li>Claude opens a BSA Sentry page: click <b>"Allow Claude to request payments from your Flex"</b>.</li>
        <li>Then ask, for example: <i>"Buy me a coffee"</i>.</li>
      </ol>
      <p>Claude can only <b>ask</b>. Your Flex signs on its own what fits your rules, asks you about the rest, and refuses what is dangerous.</p>

      <h3>Granted access</h3>
      {grants.length === 0 ? <p className="muted">None yet.</p> : (
        <ul className="grants">
          {grants.map((g) => (
            <li key={g.id}>
              <span>{g.client_name ?? 'Client'} · since {new Date(g.created_at * 1000).toLocaleString('en-GB')}</span>
              <button className="danger" onClick={async () => { await api.revokeGrant(g.id); await load(); }}>Revoke</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
