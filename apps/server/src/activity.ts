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

export function activityRouter(o: { db: Db; secret: string; now?: () => number }) {
  const router = safeRouter();
  router.get('/', (req, res) => {
    const account = readSession(req, o.secret, o.now);
    if (!account) return res.status(401).json({ error: 'log in with Ledger first' });
    const rows = o.db.prepare('SELECT type, data, at FROM activity WHERE account = ? ORDER BY id DESC LIMIT 100').all(account) as { type: string; data: string; at: number }[];
    res.json(rows.reverse().map((r) => ({ type: r.type, data: JSON.parse(r.data), at: r.at })));
  });
  return router;
}
