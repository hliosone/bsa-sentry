// The dashboard's activity, in plain words: what the agent paid (from the chain, so it includes
// payments made before this tab was open), the top-ups it received, and the requests the Flex is
// deciding or refused right now (from the live feed).
import type { FeedItem } from './feed.js';

/** One USDC transfer in or out of the agent wallet, as `GET /activity/chain` returns it. */
export type ChainTransfer = { txHash: string; at: number; from: string; to: string; value: string };

export type ActivityRow = {
  key: string;
  at: number;
  kind: 'paid' | 'topup' | 'received' | 'pending' | 'signed' | 'refused' | 'failed';
  title: string;
  /** "3.00", always two decimals. */
  amount: string;
  sign: '+' | '-' | '';
  detail?: string;
  txHash?: string;
};

const MAX_ROWS = 30;

/** "3.00" from USDC base units. */
const fromUnits = (v: string) => {
  const n = BigInt(v);
  return `${n / 1_000_000n}.${((n % 1_000_000n) / 10_000n).toString().padStart(2, '0')}`;
};
/** "3.00" from the feed's human amount ("3", "4.5"). */
const fromHuman = (a: string) => (/^\d+(\.\d+)?$/.test(a) ? Number(a).toFixed(2) : a);

export function activityRows(
  feed: FeedItem[],
  transfers: ChainTransfer[],
  o: { agent?: string; main?: string; labels: Record<string, string>; reasons?: Record<string, string> },
): ActivityRow[] {
  const agent = o.agent?.toLowerCase();
  const main = o.main?.toLowerCase();
  const onChain = new Set(transfers.map((t) => t.txHash.toLowerCase()));
  // The feed knows the merchant's name for a payment it watched settle; the chain only the address.
  const hintByTx = new Map(feed.filter((i) => i.txHash).map((i) => [i.txHash!.toLowerCase(), i.merchant]));
  const name = (addr: string, tx?: string) => o.labels[addr.toLowerCase()] ?? (tx && hintByTx.get(tx)) ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  const rows: ActivityRow[] = [];
  for (const t of transfers) {
    const tx = t.txHash.toLowerCase();
    const base = { key: tx + t.from + t.to, at: t.at, amount: fromUnits(t.value), txHash: tx };
    if (agent && t.from === agent) rows.push({ ...base, kind: 'paid', title: `Paid ${name(t.to, tx)}`, sign: '-' });
    else if (main && t.from === main) rows.push({ ...base, kind: 'topup', title: 'Top-up from your main account', sign: '+' });
    else rows.push({ ...base, kind: 'received', title: `Received from ${name(t.from, tx)}`, sign: '+' });
  }
  for (const i of feed) {
    if (i.txHash && onChain.has(i.txHash.toLowerCase())) continue;
    const base = { key: i.id, at: i.at, amount: fromHuman(i.amount), ...(i.txHash ? { txHash: i.txHash } : {}) };
    const reason = i.reason ? (o.reasons?.[i.reason] ?? i.reason) : undefined;
    switch (i.stage) {
      case 'settled': rows.push({ ...base, kind: 'paid', title: `Paid ${i.merchant}`, sign: '-' }); break;
      case 'signed': rows.push({ ...base, kind: 'signed', title: `Signed by your Flex, settling: ${i.merchant}`, sign: '' }); break;
      case 'pending': rows.push({ ...base, kind: 'pending', title: `Waiting for your Flex: ${i.merchant}`, sign: '' }); break;
      case 'refused': rows.push({ ...base, kind: 'refused', title: `Refused by your Flex: ${i.merchant}`, sign: '', ...(reason ? { detail: reason } : {}) }); break;
      case 'failed': rows.push({ ...base, kind: 'failed', title: `Not paid: ${i.merchant}`, sign: '', ...(reason ? { detail: reason } : {}) }); break;
    }
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
}

/** "Just now", "5 min ago", "2 h ago", "Yesterday, 18:13", "12 Oct, 18:13". */
export function whenText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(at);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} h ago`;
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return `Today, ${hm}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${hm}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${hm}`;
}
