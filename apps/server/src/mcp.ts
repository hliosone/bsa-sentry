// The remote MCP server claude.ai connects to, over Streamable HTTP with an OAuth Bearer.
//
// Three tools. The text they return is what the model reads and repeats to the user, so a
// refusal is phrased to stop it retrying around the device: the Flex decided, full stop.
import { Router, json, type Request } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { decodeState } from '@bsa-sentry/types';
import type { X402Result } from './agent/x402-client.js';
import { usdcAmount } from './agent/x402-client.js';
import type { TabStatus } from './relay/relay.js';
import type { Db } from './db.js';
import { requireBearer } from './oauth.js';

export type McpDeps = {
  account: string;
  explorer: string;
  agent: { fetch(account: string, req: { url: string; method?: string; body?: string }): Promise<X402Result> };
  status(account: string): TabStatus;
  /** A status read from the Flex now, when available; `status` is the cached one. */
  freshStatus?(account: string): Promise<TabStatus>;
  hasBackup(account: string): boolean;
  /** Asks the account's tab to start the restore flow. False if no tab is attached. */
  requestRestore(account: string): boolean;
};

const ok = (text: string, structured?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  ...(structured ? { structuredContent: structured } : {}),
});
const fail = (text: string, structured?: Record<string, unknown>) => ({ ...ok(text, structured), isError: true });

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'bsa-sentry', version: '0.1.0' });

  server.registerTool(
    'x402_fetch',
    {
      title: 'Fetch a URL, paying with x402 if asked',
      description:
        "Fetches a URL. If the site asks for an x402 payment (HTTP 402, USDC on Arc testnet), the payment is " +
        "requested from the user's Ledger Flex through the BSA Sentry tab. The Flex decides on its own: it signs " +
        'silently what fits the user\'s rules, asks the user on its screen for the rest, and refuses what is dangerous. ' +
        'If the result says the Flex refused, report that to the user and do not retry the payment another way.',
      inputSchema: {
        url: z.string().describe('The http(s) URL to fetch'),
        method: z.string().optional().describe('HTTP method, GET by default'),
        body: z.string().optional().describe('Request body, for POST'),
      },
    },
    async ({ url, method, body }) => {
      let r: X402Result;
      try {
        r = await deps.agent.fetch(deps.account, { url, ...(method ? { method } : {}), ...(body ? { body } : {}) });
      } catch (e) {
        return fail(`${(e as Error).message}. Ask the user to open the BSA Sentry tab in Chrome with their Flex plugged in.`);
      }
      switch (r.kind) {
        case 'free':
          return ok(r.content, { status: r.status, paid: false });
        case 'paid': {
          const link = r.receipt.txHash ? `${deps.explorer}/tx/${r.receipt.txHash}` : 'settlement pending';
          return ok(
            `Paid ${r.receipt.amount} USDC to ${r.receipt.payee}, approved by the user's Flex. Transaction: ${link}\n\n${r.content}`,
            { status: r.status, paid: true, receipt: r.receipt },
          );
        }
        case 'refused':
          return fail(
            `${r.message}\nAttempted: ${r.amount} USDC to ${r.payee}. Nothing was paid. Do not retry this payment; tell the user what the Flex said.`,
            { refused: true, reason: r.reason, amount: r.amount, payee: r.payee },
          );
        case 'error':
          return fail(r.message);
      }
    },
  );

  server.registerTool(
    'sentry_status',
    {
      title: 'BSA Sentry status',
      description: "Shows whether the user's Flex is reachable, whether the agent session is on, the remaining budget, and whether 18+ credentials and a backup exist.",
      inputSchema: {},
    },
    async () => {
      const s = deps.freshStatus ? await deps.freshStatus(deps.account) : deps.status(deps.account);
      if (!s.attached) {
        return ok('No BSA Sentry tab is attached. Ask the user to open the BSA Sentry tab in Chrome with their Flex plugged in.',
          { bridge: 'detached', flex: 'disconnected', session: false });
      }
      const lines = [`BSA Sentry tab: connected`, `Flex: ${s.flex}`];
      if (s.flex === 'locked') lines.push('The Flex is locked: ask the user to unlock it.');
      if (s.flex === 'app_closed') lines.push('The BSA Sentry app is not open on the Flex.');
      lines.push(`Agent session: ${s.session ? 'on' : 'off (the user must start it on the Flex)'}`);

      const structured: Record<string, unknown> = { bridge: 'attached', flex: s.flex, session: s.session };
      if (s.state) {
        try {
          const st = decodeState(Uint8Array.from(Buffer.from(s.state.slice(2), 'hex')));
          const left = st.policy.budget > st.spent ? st.policy.budget - st.spent : 0n;
          if (st.policy.active) {
            lines.push(`Budget: ${usdcAmount(left)} / ${usdcAmount(st.policy.budget)} USDC left (${st.count} payments so far)`);
            lines.push(`Paid without asking: up to ${usdcAmount(st.policy.autoMax)} USDC to ${st.policy.payees.length} trusted merchants; never above ${usdcAmount(st.policy.hardMax)} USDC`);
          } else {
            lines.push('No rules on the Flex yet: the user must set them on the BSA Sentry website.');
          }
          if (st.lastPayment) lines.push(`Last payment: ${st.lastPayment.label} ${usdcAmount(st.lastPayment.value)} USDC`);
          lines.push(`18+ credentials on the Flex: ${st.hasCredentials ? 'yes' : 'no'}`);
          structured.budget = { spent: usdcAmount(st.spent), total: usdcAmount(st.policy.budget), left: usdcAmount(left) };
          structured.credentials = st.hasCredentials;
        } catch { /* a stale or partial state is not worth failing the tool over */ }
      }
      const backup = deps.hasBackup(deps.account);
      lines.push(`Key Ring backup: ${backup ? 'yes' : 'no'}`);
      structured.backup = backup;
      return ok(lines.join('\n'), structured);
    },
  );

  server.registerTool(
    'sentry_restore',
    {
      title: 'Restore the Flex from the Key Ring backup',
      description: "Starts restoring the user's rules and 18+ credentials onto a wiped Flex from their Ledger Key Ring backup. The user confirms on the device.",
      inputSchema: {},
    },
    async () => {
      if (!deps.hasBackup(deps.account)) return fail('There is no backup for this account yet: nothing to restore.');
      if (!deps.requestRestore(deps.account)) {
        return fail('No BSA Sentry tab is attached. Ask the user to open the BSA Sentry tab in Chrome with their Flex plugged in.');
      }
      return ok('Restore started in the BSA Sentry tab. The user will be asked to open Ledger Sync on the Flex to decrypt the backup, then to review and approve the restored rules on the device.');
    },
  );

  return server;
}

/** POST /mcp, stateless: one server per request, scoped to the token's account. */
export function mcpRouter(opts: { db: Db; baseUrl: string } & Omit<McpDeps, 'account'>) {
  const router = Router();
  const auth = requireBearer({ db: opts.db, baseUrl: opts.baseUrl });
  router.post('/mcp', json({ limit: '256kb' }), auth, async (req, res) => {
    const account = (req as Request & { account: string }).account;
    const server = buildMcpServer({ ...opts, account });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  // Stateless server: no server-initiated stream, no session to delete.
  router.get('/mcp', auth, (_req, res) => res.status(405).set('Allow', 'POST').end());
  router.delete('/mcp', auth, (_req, res) => res.status(405).set('Allow', 'POST').end());
  return router;
}
