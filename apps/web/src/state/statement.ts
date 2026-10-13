// The agent wallet as a bank statement: every USDC transfer booked as a debit (a payment) or a
// credit (a top-up), sorted into spending categories, and exportable as an ISO 20022 camt.053
// statement for an accountant. The structure follows the camt.053 exporter of our earlier Edel
// Gate project (docs/PREEXISTING.md); this version books debits and credits and passes the
// camt.053.001.02 schema (test/statement.test.ts runs xmllint on it).
import type { ChainTransfer } from './activity.js';

export type Merchant = { address: string; label: string; category: string };

export type StatementEntry = {
  txHash: string;
  at: number;
  direction: 'debit' | 'credit';
  counterparty: string;
  name: string;
  category: string;
  units: bigint;
};

export type Period = 'month' | 'year' | 'all';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Newest first. Payments to a known merchant take its category; top-ups are "Top-ups". */
export function statementEntries(transfers: ChainTransfer[], o: { agent?: string; main?: string; merchants: Merchant[] }): StatementEntry[] {
  const agent = o.agent?.toLowerCase();
  const main = o.main?.toLowerCase();
  const known = new Map(o.merchants.map((m) => [m.address.toLowerCase(), m]));
  const out: StatementEntry[] = [];
  for (const t of transfers) {
    const base = { txHash: t.txHash.toLowerCase(), at: t.at, units: BigInt(t.value) };
    if (agent && t.from === agent) {
      const m = known.get(t.to);
      out.push({ ...base, direction: 'debit', counterparty: t.to, name: m?.label ?? short(t.to), category: m?.category ?? 'Other' });
    } else if (main && t.from === main) {
      out.push({ ...base, direction: 'credit', counterparty: t.from, name: 'Your main account', category: 'Top-ups' });
    } else {
      out.push({ ...base, direction: 'credit', counterparty: t.from, name: known.get(t.from)?.label ?? short(t.from), category: 'Received' });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export function periodRange(p: Period, now = Date.now()): { from: number; to: number } {
  const d = new Date(now);
  if (p === 'month') return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now };
  if (p === 'year') return { from: new Date(d.getFullYear(), 0, 1).getTime(), to: now };
  return { from: 0, to: now };
}

/** Spending per category, biggest first. Credits are not spending. */
export function byCategory(entries: StatementEntry[]): { category: string; units: bigint; count: number }[] {
  const m = new Map<string, { category: string; units: bigint; count: number }>();
  for (const e of entries) {
    if (e.direction !== 'debit') continue;
    const c = m.get(e.category) ?? { category: e.category, units: 0n, count: 0 };
    c.units += e.units;
    c.count += 1;
    m.set(e.category, c);
  }
  return [...m.values()].sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0));
}

export function totals(entries: StatementEntry[]): { spent: bigint; received: bigint; payments: number } {
  let spent = 0n, received = 0n, payments = 0;
  for (const e of entries) {
    if (e.direction === 'debit') { spent += e.units; payments += 1; } else received += e.units;
  }
  return { spent, received, payments };
}

/** USDC base units (6 dp) as a camt amount: at least 2 decimals, at most the schema's 5. */
export function camtAmount(units: bigint): string {
  const u = units < 0n ? -units : units;
  const r = u % 10n >= 5n ? u / 10n + 1n : u / 10n; // 5 decimals, rounded half up
  const frac = (r % 100_000n).toString().padStart(5, '0').replace(/0{1,3}$/, '');
  return `${r / 100_000n}.${frac}`;
}

const esc = (s: string) =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const dtTm = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * A camt.053.001.02 statement of the agent wallet over [from, to]. `entries` must be the period's
 * entries; `closing` is the wallet balance at `to`, and the opening balance is derived from it.
 * Amounts are in USD at 1 USDC = 1 USD (camt needs an ISO 4217 code); every entry says so.
 * EVM addresses (42 chars) do not fit camt's 34-char account id, so the id holds a prefix and the
 * name holds the full address.
 */
export function camt053(o: { account: string; entries: StatementEntry[]; from: number; to: number; closing: bigint; now: number; network: string; chainId: number }): string {
  const t = totals(o.entries);
  const opening = o.closing - t.received + t.spent;
  const bal = (cd: string, units: bigint, at: number) =>
    `<Bal><Tp><CdOrPrtry><Cd>${cd}</Cd></CdOrPrtry></Tp><Amt Ccy="USD">${camtAmount(units)}</Amt><CdtDbtInd>${units < 0n ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${day(at)}</Dt></Dt></Bal>`;
  const wallet = `BSA Sentry agent wallet ${o.account}`;
  const party = (nm: string) => `<Nm>${esc(nm)}</Nm>`;
  const credits = o.entries.filter((e) => e.direction === 'credit');
  const debits = o.entries.filter((e) => e.direction === 'debit');

  const entry = (e: StatementEntry) => {
    const debit = e.direction === 'debit';
    const ref = esc(e.txHash.slice(0, 35));
    const other = `${e.name} (${e.counterparty})`;
    return `
      <Ntry>
        <Amt Ccy="USD">${camtAmount(e.units)}</Amt>
        <CdtDbtInd>${debit ? 'DBIT' : 'CRDT'}</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><DtTm>${dtTm(e.at)}</DtTm></BookgDt>
        <ValDt><DtTm>${dtTm(e.at)}</DtTm></ValDt>
        <AcctSvcrRef>${ref}</AcctSvcrRef>
        <BkTxCd>
          <Domn><Cd>PMNT</Cd><Fmly><Cd>${debit ? 'ICDT' : 'RCDT'}</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn>
          <Prtry><Cd>${debit ? 'x402 payment' : 'USDC transfer in'}</Cd><Issr>BSA Sentry</Issr></Prtry>
        </BkTxCd>
        <NtryDtls>
          <TxDtls>
            <Refs><TxId>${ref}</TxId></Refs>
            <RltdPties>
              <Dbtr>${party(debit ? wallet : other)}</Dbtr>
              <Cdtr>${party(debit ? other : wallet)}</Cdtr>
            </RltdPties>
            <RmtInf>
              <Ustrd>${esc(`Category: ${e.category}`)}</Ustrd>
              <Ustrd>USDC on ${esc(o.network)}, 1 USDC = 1 USD</Ustrd>
            </RmtInf>
            <AddtlTxInf>${esc(`${o.network} transaction ${e.txHash}`)}</AddtlTxInf>
          </TxDtls>
        </NtryDtls>
        <AddtlNtryInf>${esc(`${e.name}, ${e.category}`)}</AddtlNtryInf>
      </Ntry>`;
  };

  const net = t.received - t.spent;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>BSA-${o.now}</MsgId>
      <CreDtTm>${dtTm(o.now)}</CreDtTm>
      <MsgPgntn><PgNb>1</PgNb><LastPgInd>true</LastPgInd></MsgPgntn>
      <AddtlInf>${esc(`BSA Sentry statement of the agent wallet ${o.account}. USDC on ${o.network} (chain ${o.chainId}), shown in USD at 1 USDC = 1 USD.`)}</AddtlInf>
    </GrpHdr>
    <Stmt>
      <Id>BSA-STMT-${day(o.from).replace(/-/g, '')}-${day(o.to).replace(/-/g, '')}</Id>
      <ElctrncSeqNb>1</ElctrncSeqNb>
      <CreDtTm>${dtTm(o.now)}</CreDtTm>
      <FrToDt><FrDtTm>${dtTm(o.from)}</FrDtTm><ToDtTm>${dtTm(o.to)}</ToDtTm></FrToDt>
      <Acct>
        <Id><Othr><Id>${esc(o.account.slice(0, 34))}</Id><SchmeNm><Prtry>EVM address prefix</Prtry></SchmeNm></Othr></Id>
        <Ccy>USD</Ccy>
        <Nm>${esc(wallet)}</Nm>
        <Svcr><FinInstnId><Nm>${esc(`${o.network}, USDC`)}</Nm><Othr><Id>eip155:${o.chainId}</Id><SchmeNm><Prtry>CAIP-2 chain</Prtry></SchmeNm></Othr></FinInstnId></Svcr>
      </Acct>
      ${bal('OPBD', opening, o.from)}
      ${bal('CLBD', o.closing, o.to)}
      <TxsSummry>
        <TtlNtries><NbOfNtries>${o.entries.length}</NbOfNtries><TtlNetNtryAmt>${camtAmount(net)}</TtlNetNtryAmt><CdtDbtInd>${net < 0n ? 'DBIT' : 'CRDT'}</CdtDbtInd></TtlNtries>
        <TtlCdtNtries><NbOfNtries>${credits.length}</NbOfNtries><Sum>${camtAmount(t.received)}</Sum></TtlCdtNtries>
        <TtlDbtNtries><NbOfNtries>${debits.length}</NbOfNtries><Sum>${camtAmount(t.spent)}</Sum></TtlDbtNtries>
      </TxsSummry>${[...o.entries].sort((a, b) => a.at - b.at).map(entry).join('')}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
}
