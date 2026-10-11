// What the dashboard learns after a payment: settled with its tx hash, refused with the
// device reason, or failed. One event per x402_fetch that asked for money.
import { describe, expect, it } from 'vitest';
import { paymentEvent } from '../src/agent/events.js';

const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175' as const;

describe('paymentEvent', () => {
  it('reports a settled payment with its transaction', () => {
    const e = paymentEvent('alice', 'https://m/cafe', {
      kind: 'paid', status: 200, content: 'x',
      receipt: { decision: 'approved', amount: '3', payee: CAFE, txHash: '0xabc', network: 'eip155:5042002' },
    }, 1000);
    expect(e).toEqual({ account: 'alice', kind: 'paid', url: 'https://m/cafe', amount: '3', payee: CAFE, txHash: '0xabc', at: 1000 });
  });

  it('reports a refusal with the device reason', () => {
    const e = paymentEvent('alice', 'https://m/evil', { kind: 'refused', reason: 'OVER_HARD_MAX', message: 'm', amount: '400', payee: CAFE }, 1);
    expect(e).toMatchObject({ kind: 'refused', amount: '400', payee: CAFE, message: 'OVER_HARD_MAX' });
  });

  it('says nothing about a free page', () => {
    expect(paymentEvent('alice', 'https://m/promo', { kind: 'free', status: 200, content: '' }, 1)).toBeNull();
  });

  it('carries the amount and payee of a signed payment that then failed', () => {
    const e = paymentEvent('alice', 'https://m/cafe', { kind: 'error', message: 'rejected', amount: '3', payee: CAFE }, 1);
    expect(e).toMatchObject({ kind: 'error', amount: '3', payee: CAFE, message: 'rejected' });
  });

  it('reports an error without inventing an amount', () => {
    const e = paymentEvent('alice', 'https://m/x', { kind: 'error', message: 'merchant down' }, 1);
    expect(e).toEqual({ account: 'alice', kind: 'error', url: 'https://m/x', message: 'merchant down', at: 1 });
  });
});
