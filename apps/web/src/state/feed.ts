// The dashboard's live feed: each payment request, then what the Flex decided, then what the
// chain did. Fed by the server's /events stream.
import type { BridgeReason } from '@bsa-sentry/types';

export type FeedItem = {
  id: string;
  at: number;
  merchant: string;
  amount: string;
  payee: string;
  stage: 'pending' | 'signed' | 'refused' | 'settled' | 'failed';
  reason?: BridgeReason | string;
  txHash?: string;
};

export type FeedEvent =
  | { type: 'request'; id: string; at: number; message: { type: string; fields?: { to?: string; value?: string }; hint?: string } }
  | { type: 'answer'; id: string; answer: { ok: boolean; reason?: string } }
  | { type: 'payment'; kind: 'paid' | 'refused' | 'error'; url: string; amount?: string; payee?: string; txHash?: string; at: number; message?: string }
  | { type: 'dismiss' };

export type FeedState = { items: FeedItem[]; banner: { reason: string; amount: string; merchant: string } | null };

export const initialFeed: FeedState = { items: [], banner: null };

const MAX_ITEMS = 50;

const usdc = (units?: string) => {
  if (!units || !/^\d+$/.test(units)) return '?';
  const v = BigInt(units);
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${v / 1_000_000n}.${frac}` : `${v / 1_000_000n}`;
};

export function feedReducer(state: FeedState, e: FeedEvent): FeedState {
  switch (e.type) {
    case 'request': {
      if (e.message.type !== 'sign_payment') return state;
      const item: FeedItem = {
        id: e.id, at: e.at, stage: 'pending',
        merchant: e.message.hint || 'Marchand',
        amount: usdc(e.message.fields?.value),
        payee: (e.message.fields?.to ?? '').toLowerCase(),
      };
      return { ...state, items: [item, ...state.items].slice(0, MAX_ITEMS) };
    }
    case 'answer': {
      const item = state.items.find((i) => i.id === e.id);
      if (!item) return state;
      const updated: FeedItem = e.answer.ok
        ? { ...item, stage: 'signed' }
        : { ...item, stage: 'refused', reason: e.answer.reason };
      return {
        items: state.items.map((i) => (i.id === e.id ? updated : i)),
        banner: e.answer.ok ? state.banner : { reason: e.answer.reason ?? 'REFUSED', amount: item.amount, merchant: item.merchant },
      };
    }
    case 'payment': {
      // Settlement is reported per payee + amount; match the most recent signed request.
      const idx = state.items.findIndex((i) => i.stage === 'signed' && i.payee === (e.payee ?? '').toLowerCase() && i.amount === e.amount);
      if (idx < 0) return state;
      const items = [...state.items];
      items[idx] = e.kind === 'paid'
        ? { ...items[idx]!, stage: 'settled', ...(e.txHash ? { txHash: e.txHash } : {}) }
        : { ...items[idx]!, stage: 'failed', reason: e.message };
      return { ...state, items };
    }
    case 'dismiss':
      return { ...state, banner: null };
  }
}
