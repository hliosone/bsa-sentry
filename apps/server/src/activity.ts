// The dashboard's activity, kept so it survives a reload: each account's payment requests, the
// Flex's answers, and the settlements. No identity data: amounts, merchants, decisions.
import type { EventEmitter } from 'node:events';
import type { Db } from './db.js';
import { readSession } from './auth.js';
import { safeRouter } from './safe-router.js';

const KEEP = 200;

export function recordActivity(db: Db, events: EventEmitter, now: () => number = Date.now) {
  const insert = db.prepare('INSERT INTO activity (account, type, data, at) VALUES (?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM activity WHERE account = ? AND id NOT IN (SELECT id FROM activity WHERE account = ? ORDER BY id DESC LIMIT ?)');
  const keep = (type: string) => (e: { account: string; message?: { type?: string } }) => {
    // A status poll is not activity; only payment requests are.
    if (type === 'request' && e.message?.type !== 'sign_payment') return;
    insert.run(e.account, type, JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), now());
    prune.run(e.account, e.account, KEEP);
  };
  for (const type of ['request', 'answer', 'payment']) events.on(type, keep(type));
}

/** One USDC transfer in or out of the agent wallet, as the explorer reports it. */
export type ChainTransfer = { txHash: string; at: number; from: string; to: string; value: string };

export type ChainHistory = {
  explorer: string;
  usdc: string;
  agentOf(account: string): string | undefined;
  fetchImpl?: typeof fetch;
};

const CACHE_MS = 10_000;
/** The explorer pages 50 transfers at a time; 20 pages is more than a demo wallet ever holds. */
const MAX_PAGES = 20;

/**
 * The agent wallet's USDC transfers, from the explorer's Blockscout API: the payments it made and
 * the top-ups it received, including those from before this server kept any activity. Only the
 * configured USDC counts (a spam token sent to the agent must never look like a payment).
 */
async function chainTransfers(c: ChainHistory, agent: string): Promise<ChainTransfer[]> {
  const base = `${c.explorer.replace(/\/$/, '')}/api/v2/addresses/${agent}/token-transfers?type=ERC-20`;
  const items: any[] = [];
  let next: Record<string, unknown> | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = next ? `${base}&${new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)]))}` : base;
    const res = await (c.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`explorer answered ${res.status}`);
    const body = (await res.json()) as { items?: any[]; next_page_params?: Record<string, unknown> | null };
    items.push(...(body.items ?? []));
    next = body.next_page_params ?? null;
    if (!next) break;
  }
  const usdc = c.usdc.toLowerCase();
  return items
    .filter((x) => String(x?.token?.address_hash ?? x?.token?.address ?? '').toLowerCase() === usdc && /^\d+$/.test(String(x?.total?.value ?? '')))
    .map((x) => ({
      txHash: String(x.transaction_hash).toLowerCase(),
      at: Date.parse(x.timestamp),
      from: String(x.from?.hash ?? '').toLowerCase(),
      to: String(x.to?.hash ?? '').toLowerCase(),
      value: String(x.total.value),
    }));
}

export function activityRouter(o: { db: Db; secret: string; now?: () => number; chain?: ChainHistory }) {
  const router = safeRouter();
  const cache = new Map<string, { at: number; items: ChainTransfer[] }>();

  router.get('/chain', async (req, res) => {
    const account = readSession(req, o.secret, o.now);
    if (!account) return res.status(401).json({ error: 'log in with Ledger first' });
    const agent = o.chain?.agentOf(account)?.toLowerCase();
    if (!o.chain || !agent) return res.json({ agent: null, transfers: [] });
    const hit = cache.get(agent);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json({ agent, transfers: hit.items });
    try {
      const items = await chainTransfers(o.chain, agent);
      cache.set(agent, { at: Date.now(), items });
      res.json({ agent, transfers: items });
    } catch (e) {
      res.status(502).json({ error: `could not read the agent's history from the explorer: ${(e as Error).message}` });
    }
  });

  router.get('/', (req, res) => {
    const account = readSession(req, o.secret, o.now);
    if (!account) return res.status(401).json({ error: 'log in with Ledger first' });
    const rows = o.db.prepare('SELECT type, data, at FROM activity WHERE account = ? ORDER BY id DESC LIMIT 100').all(account) as { type: string; data: string; at: number }[];
    res.json(rows.reverse().map((r) => ({ type: r.type, data: JSON.parse(r.data), at: r.at })));
  });
  return router;
}
