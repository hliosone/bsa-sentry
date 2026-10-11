// Turns an x402_fetch outcome into the dashboard event that follows the relay's own
// request/answer events: the settlement (with its tx hash) or why nothing was paid.
import type { X402Result } from './x402-client.js';

export type PaymentEvent = {
  account: string;
  kind: 'paid' | 'refused' | 'error';
  url: string;
  amount?: string;
  payee?: string;
  txHash?: string;
  message?: string;
  at: number;
};

export function paymentEvent(account: string, url: string, r: X402Result, at = Date.now()): PaymentEvent | null {
  switch (r.kind) {
    case 'free':
      return null;
    case 'paid':
      return { account, kind: 'paid', url, amount: r.receipt.amount, payee: r.receipt.payee, ...(r.receipt.txHash ? { txHash: r.receipt.txHash } : {}), at };
    case 'refused':
      return { account, kind: 'refused', url, amount: r.amount, payee: r.payee, message: r.reason, at };
    case 'error':
      return { account, kind: 'error', url, message: r.message, ...(r.amount ? { amount: r.amount } : {}), ...(r.payee ? { payee: r.payee } : {}), at };
  }
}
