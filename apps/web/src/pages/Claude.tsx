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
      <h2>Connect your agent</h2>
      <p>BSA Sentry is a remote MCP server. Any agent that supports remote MCP servers with OAuth can use it (tested with Claude). The agent gets three tools: <code>x402_fetch</code> (open a page and pay for it if it asks), <code>sentry_status</code> and <code>sentry_restore</code>.</p>
      <ol className="steps-howto">
        <li>Add this URL to your agent as a remote MCP server:
          <div className="copy">
            <code data-testid="mcp-url">{url}</code>
            <button className="ghost" onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <span className="muted">In Claude (claude.ai or Claude Desktop): Settings, Connectors, <b>Add custom connector</b>.</span>
        </li>
        <li>Your agent opens a BSA Sentry page: log in with your Ledger if asked, then click <b>Allow</b>.</li>
        <li>Then ask it, for example: <i>"Buy me a coffee at the cafe"</i>.</li>
      </ol>
      <p>The agent can only <b>ask</b>. Your Flex signs on its own what fits your rules, asks you about the rest, and refuses what is dangerous.</p>

      <h3>Granted access</h3>
      {grants.length === 0 ? <p className="muted">None yet.</p> : (
        <ul className="grants">
          {grants.map((g) => (
            <li key={g.id}>
              <span>{g.client_name ?? 'Agent'}, since {new Date(g.created_at * 1000).toLocaleString('en-GB')}</span>
              <button className="danger" onClick={async () => { await api.revokeGrant(g.id); await load(); }}>Revoke</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
