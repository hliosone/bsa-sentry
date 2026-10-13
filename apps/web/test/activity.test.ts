import { describe, expect, it } from 'vitest';
import { activityRows, failureText, whenText, type ChainTransfer } from '../src/state/activity.js';
import type { FeedItem } from '../src/state/feed.js';

const AGENT = '0x1c9940ef87ce842fb18d73fd43b49b53582c6b52';
const MAIN = '0x091da3c5e376db04928a9d8d5196716024e4318f';
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';
const labels = { [CAFE]: 'Cafe Satoshi' };

const t = (over: Partial<ChainTransfer>): ChainTransfer => ({ txHash: '0x01', at: 1_000, from: AGENT, to: CAFE, value: '3000000', ...over });
const f = (over: Partial<FeedItem>): FeedItem => ({ id: 'r1', at: 5_000, merchant: 'Wine shop', amount: '4.5', payee: CAFE, stage: 'pending', ...over });

describe('activity rows', () => {
  it('turns chain transfers into payments and top-ups, named, newest first', () => {
    const rows = activityRows([], [t({}), t({ txHash: '0x02', at: 2_000, from: MAIN, to: AGENT, value: '5000000' })], { agent: AGENT, main: MAIN, labels });
    expect(rows.map((r) => [r.kind, r.title, r.sign, r.amount])).toEqual([
      ['topup', 'Top-up from your main account', '+', '5.00'],
      ['paid', 'Paid Cafe Satoshi', '-', '3.00'],
    ]);
  });

  it('shows live decisions, and a settled payment once even when the chain also has it', () => {
    const rows = activityRows(
      [f({ id: 'a', stage: 'refused', reason: 'OVER_HARD_MAX', at: 9_000 }), f({ id: 'b', stage: 'settled', txHash: '0x01', merchant: 'Cafe' })],
      [t({})],
      { agent: AGENT, main: MAIN, labels: {}, reasons: { OVER_HARD_MAX: 'above your hard limit' } },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'refused', title: 'Refused by your Flex: Wine shop', detail: 'above your hard limit', amount: '4.50' });
    // The chain row borrows the merchant name the live feed saw.
    expect(rows[1]).toMatchObject({ kind: 'paid', title: 'Paid Cafe', txHash: '0x01' });
  });

  it('falls back to a short address for an unknown merchant', () => {
    expect(activityRows([], [t({ to: '0xabcdef0000000000000000000000000000001234' })], { agent: AGENT, labels: {} })[0]!.title).toBe('Paid 0xabcd…1234');
  });
});

describe('why a signed payment was not paid, in the user\'s words', () => {
  const host = 'server-production-423c.up.railway.app rejected the signed payment (HTTP 402): ';
  it('names the missing right and where to grant it', () => {
    expect(failureText(`${host}DELEGATION_MISSING_CLAIM. This merchant requires proof of: 18 or older. The user can add it on the BSA Sentry website (Agent identity, then authorize the agent on the Flex).`))
      .toBe('The shop requires proof that you are 18 or older, and your agent does not hold that right. Grant it in Agent identity. No money moved.');
    expect(failureText(`${host}AGE_PROOF_REQUIRED. This merchant requires proof of: not a US person. The user can add it`))
      .toBe('The shop requires proof that you are not a US person, and your agent does not hold that right. Grant it in Agent identity. No money moved.');
  });
  it('explains revoked, expired and unverifiable rights, and an empty wallet', () => {
    expect(failureText(`${host}DELEGATION_REVOKED. The user revoked`)).toBe('You revoked the rights your agent held. Grant new ones in Agent identity. No money moved.');
    expect(failureText(`${host}ATTESTATION_EXPIRED. This merchant requires proof of: 18 or older.`)).toBe('Your agent\'s rights have expired. Grant them again in Agent identity. No money moved.');
    expect(failureText(`${host}DELEGATION_WRONG_AGENT. This merchant`)).toBe('The shop could not verify your agent\'s rights. Grant them again in Agent identity. No money moved.');
    expect(failureText(`${host}insufficient_funds. The agent account has not enough USDC on Arc testnet.`)).toBe('Not enough USDC in the agent wallet. Top it up from your main account. No money moved.');
  });
  it('keeps anything else as it came', () => {
    expect(failureText('the payment was signed but shop.test could not be reached: timeout')).toBe('the payment was signed but shop.test could not be reached: timeout');
  });
});

describe('transfers back to the main account', () => {
  it('are not payments to a stranger', () => {
    expect(activityRows([], [t({ to: MAIN, value: '35000000' })], { agent: AGENT, main: MAIN, labels: {} })[0]).toMatchObject({ kind: 'sent', title: 'Sent to your main account', sign: '-', amount: '35.00' });
  });
});

describe('when', () => {
  const now = Date.parse('2026-10-13T15:00:00Z');
  it('reads like a bank statement', () => {
    expect(whenText(now - 20_000, now)).toBe('Just now');
    expect(whenText(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(whenText(now - 2 * 3_600_000, now)).toBe('2 h ago');
    expect(whenText(now - 30 * 3_600_000, now)).toMatch(/^Yesterday, \d\d:\d\d$/);
    expect(whenText(now - 5 * 86_400_000, now)).toMatch(/^8 Oct, \d\d:\d\d$/);
  });
});
