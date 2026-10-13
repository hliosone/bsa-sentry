import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { balanceAt, byCategory, camtAmount, camt053, periodRange, statementEntries, totals } from '../src/state/statement.js';
import type { ChainTransfer } from '../src/state/activity.js';

const AGENT = '0x1c9940ef87ce842fb18d73fd43b49b53582c6b52';
const MAIN = '0x091da3c5e376db04928a9d8d5196716024e4318f';
const CAFE = '0x5069ee8f83b7181f031518d1375eae270f884175';
const WINE = '0x7a00000000000000000000000000000000000001';
const merchants = [
  { address: CAFE, label: 'Cafe Sat', category: 'Food and drink' },
  { address: WINE, label: 'Corner <Wines> & Co', category: 'Alcohol' },
];
const t = (over: Partial<ChainTransfer>): ChainTransfer => ({ txHash: `0x${'ab'.repeat(32)}`, at: Date.parse('2026-10-12T10:00:00Z'), from: AGENT, to: CAFE, value: '3000000', ...over });
const transfers: ChainTransfer[] = [
  t({ txHash: `0x${'01'.repeat(32)}`, from: MAIN, to: AGENT, value: '20000000', at: Date.parse('2026-10-10T09:00:00Z') }),
  t({ txHash: `0x${'02'.repeat(32)}` }),
  t({ txHash: `0x${'03'.repeat(32)}`, to: WINE, value: '4500000', at: Date.parse('2026-10-12T11:00:00Z') }),
  t({ txHash: `0x${'04'.repeat(32)}`, to: '0xdead00000000000000000000000000000000beef', value: '100000', at: Date.parse('2026-10-12T12:00:00Z') }),
];
const entries = statementEntries(transfers, { agent: AGENT, main: MAIN, merchants });

describe('statement entries', () => {
  it('books payments as debits under the merchant category, top-ups as credits, unknown payees as Other', () => {
    expect(entries.map((e) => [e.direction, e.name, e.category, e.units])).toEqual([
      ['debit', '0xdead…beef', 'Other', 100000n],
      ['debit', 'Corner <Wines> & Co', 'Alcohol', 4500000n],
      ['debit', 'Cafe Sat', 'Food and drink', 3000000n],
      ['credit', 'Your main account', 'Top-ups', 20000000n],
    ]);
  });

  it('counts a transfer back to the main account as sent, not spent', () => {
    const e = statementEntries([t({ to: MAIN, value: '35000000' })], { agent: AGENT, main: MAIN, merchants });
    expect(e[0]).toMatchObject({ direction: 'debit', name: 'Your main account', category: 'Sent to main account' });
    expect(totals(e)).toEqual({ spent: 0n, sent: 35000000n, received: 0n, payments: 0 });
    expect(byCategory(e)).toEqual([]);
  });

  it('sums spending per category, biggest first, and the period totals', () => {
    expect(byCategory(entries)).toEqual([
      { category: 'Alcohol', units: 4500000n, count: 1 },
      { category: 'Food and drink', units: 3000000n, count: 1 },
      { category: 'Other', units: 100000n, count: 1 },
    ]);
    expect(totals(entries)).toEqual({ spent: 7600000n, sent: 0n, received: 20000000n, payments: 3 });
  });

  it('turns a period into a date range', () => {
    const now = Date.parse('2026-10-13T15:00:00Z');
    expect(new Date(periodRange('month', now).from).getDate()).toBe(1);
    expect(new Date(periodRange('year', now).from).getMonth()).toBe(0);
    expect(periodRange('all', now).from).toBe(0);
    expect(periodRange('month', now).to).toBe(now);
    const last = periodRange('lastMonth', now);
    expect([new Date(last.from).getMonth(), new Date(last.from).getDate()]).toEqual([8, 1]);
    expect(new Date(last.to).getMonth()).toBe(8);
    expect(new Date(last.to + 1).getMonth()).toBe(9);
  });

  it('works out the wallet balance at any date from today\'s balance and the history', () => {
    // Today 12.40; before Oct 10 nothing had arrived; after the top-up 20.00; after everything 12.40.
    expect(balanceAt(entries, 12_400_000n, Date.parse('2026-10-09T00:00:00Z'))).toBe(0n);
    expect(balanceAt(entries, 12_400_000n, Date.parse('2026-10-11T00:00:00Z'))).toBe(20_000_000n);
    expect(balanceAt(entries, 12_400_000n, Date.parse('2026-10-13T00:00:00Z'))).toBe(12_400_000n);
  });
});

describe('ISO 20022 camt.053 export', () => {
  const xml = camt053({
    account: AGENT, entries, from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-13T15:00:00Z'),
    opening: 0n, closing: 12_400_000n, now: Date.parse('2026-10-13T15:00:00Z'), network: 'Arc testnet', chainId: 5042002,
  });

  it('amounts fit the schema: at most 5 decimals, never negative', () => {
    expect(camtAmount(3_500_000n)).toBe('3.50');
    expect(camtAmount(100_000n)).toBe('0.10');
    expect(camtAmount(1_234_567n)).toBe('1.23457');
    expect(camtAmount(20_000_000n)).toBe('20.00');
  });

  it('books debits and credits with real totals and opening and closing balances', () => {
    expect(xml).toContain('<TtlCdtNtries><NbOfNtries>1</NbOfNtries><Sum>20.00</Sum></TtlCdtNtries>');
    expect(xml).toContain('<TtlDbtNtries><NbOfNtries>3</NbOfNtries><Sum>7.60</Sum></TtlDbtNtries>');
    // closing 12.40 = opening + 20.00 - 7.60, so opening is 0.00.
    expect(xml).toMatch(/<Cd>OPBD<\/Cd><\/CdOrPrtry><\/Tp><Amt Ccy="USD">0.00<\/Amt><CdtDbtInd>CRDT/);
    expect(xml).toMatch(/<Cd>CLBD<\/Cd><\/CdOrPrtry><\/Tp><Amt Ccy="USD">12.40<\/Amt><CdtDbtInd>CRDT/);
    expect(xml.match(/<CdtDbtInd>DBIT<\/CdtDbtInd>\s*<Sts>/g)).toHaveLength(3);
    expect(xml).toContain(`Arc testnet transaction 0x${'03'.repeat(32)}`);
  });

  it('says when a statement is filtered', () => {
    const food = camt053({
      account: AGENT, entries: entries.filter((e) => e.category === 'Food and drink'), from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-13T15:00:00Z'),
      opening: 0n, closing: 12_400_000n, now: Date.parse('2026-10-13T15:00:00Z'), network: 'Arc testnet', chainId: 5042002, filter: 'Food and drink',
    });
    expect(food).toContain('<TtlDbtNtries><NbOfNtries>1</NbOfNtries><Sum>3.00</Sum></TtlDbtNtries>');
    expect(food).toContain('<AddtlStmtInf>Filtered: Food and drink. The balances cover the whole wallet.</AddtlStmtInf>');
  });

  it('escapes merchant names and uses a 3-letter currency', () => {
    expect(xml).toContain('Corner &lt;Wines&gt; &amp; Co');
    expect(xml).not.toContain('<Wines>');
    expect(xml).not.toMatch(/Ccy="(?![A-Z]{3}")/);
  });

  it('validates against the camt.053.001.02 schema', () => {
    let hasXmllint = true;
    try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); } catch { hasXmllint = false; }
    if (!hasXmllint) return;
    const dir = mkdtempSync(join(tmpdir(), 'camt-'));
    const xsd = join(import.meta.dirname, 'fixtures/camt.053.001.02.xsd');
    const filtered = camt053({ account: AGENT, entries: entries.slice(0, 1), from: 0, to: 1, opening: -1n, closing: 0n, now: 2, network: 'Arc testnet', chainId: 5042002, filter: 'Other' });
    for (const [i, doc] of [xml, filtered].entries()) {
      const file = join(dir, `statement-${i}.xml`);
      writeFileSync(file, doc);
      expect(() => execFileSync('xmllint', ['--noout', '--schema', xsd, file], { stdio: 'pipe' })).not.toThrow();
    }
  });
});
