import { cents, sum, type AccountingJournal, type SystemAccountCode, SYSTEM_CHART } from '@greystone/commission';

export interface PostedJournal extends Omit<AccountingJournal, 'lines'> {
  id: string;
  lines: Array<AccountingJournal['lines'][number] & { id?: string; dealId?: string | null; repId?: string | null }>;
  /** Immutable correction-chain identity. Optional for callers with pre-chain journals. */
  logicalSourceKey?: string;
  sourceVersion?: number;
  reversalOf?: string | null;
  correctionDate?: string | null;
}
export interface TrialBalanceRow { accountCode: SystemAccountCode; name: string; debit: number; credit: number; balance: number; journals: string[] }
const inRange = (j: Pick<AccountingJournal, 'date'>, from?: string, to?: string) => (!from || j.date >= from) && (!to || j.date <= to);
const normal = (code: SystemAccountCode) => code.startsWith('1') || code.startsWith('5') ? 'debit' : 'credit';

/** Journal-only report primitive. Positive balances use each account's normal side. */
export function trialBalance(journals: PostedJournal[], from?: string, to?: string): { rows: TrialBalanceRow[]; totals: { debit: number; credit: number }; balanced: boolean } {
  const included = journals.filter((j) => inRange(j, from, to));
  const rows = SYSTEM_CHART.map((account) => {
    const lines = included.flatMap((j) => j.lines.filter((l) => l.accountCode === account.code).map((l) => ({ ...l, key: j.sourceKey })));
    const debit = sum(lines.map((l) => l.debit));
    const credit = sum(lines.map((l) => l.credit));
    return { accountCode: account.code, name: account.name, debit, credit, balance: cents(normal(account.code) === 'debit' ? debit - credit : credit - debit), journals: [...new Set(lines.map((l) => l.key))] };
  }).filter((r) => r.debit || r.credit);
  const totals = { debit: sum(rows.map((r) => r.debit)), credit: sum(rows.map((r) => r.credit)) };
  return { rows, totals, balanced: totals.debit === totals.credit };
}

export function profitAndLoss(journals: PostedJournal[], from?: string, to?: string) {
  const tb = trialBalance(journals, from, to);
  const row = (code: SystemAccountCode) => tb.rows.find((x) => x.accountCode === code)?.balance ?? 0;
  const contra = tb.rows.find((x) => x.accountCode === '4090');
  // 4090 is deliberately debit-normal even though it is in the 4xxx revenue
  // family: debit clawbacks reduce revenue rather than increasing it.
  const revenue = row('4000'); const clawbacks = contra ? cents(contra.debit - contra.credit) : 0; const expenses = cents(row('5000') + row('5010') + row('5020'));
  return { from: from ?? null, to: to ?? null, revenue, clawbacks, netRevenue: cents(revenue - clawbacks), expenses, netIncome: cents(revenue - clawbacks - expenses), drilldown: tb.rows.filter((r) => ['4000', '4090', '5000', '5010', '5020'].includes(r.accountCode)) };
}
export function balanceSheet(journals: PostedJournal[], asOf?: string) {
  const tb = trialBalance(journals, undefined, asOf);
  const get = (c: SystemAccountCode) => tb.rows.find((r) => r.accountCode === c)?.balance ?? 0;
  const assets = cents(get('1000') + get('1100') + get('1200')); const liabilities = cents(get('2000') + get('2010'));
  // Closing earnings are retained equity for this lightweight fixed chart.
  const equity = cents(get('3000') + profitAndLoss(journals, undefined, asOf).netIncome);
  return { asOf: asOf ?? null, assets, liabilities, equity, balanced: assets === cents(liabilities + equity), drilldown: tb.rows.filter((r) => ['1000', '1100', '1200', '2000', '2010', '3000'].includes(r.accountCode)) };
}
export function directCashFlow(journals: PostedJournal[], from?: string, to?: string) {
  // Corrections are append-only reversal + replacement postings. Classifying
  // those physical rows separately manufactures a gross inflow and outflow.
  // Net each logical source within the requested reporting period first: a
  // chain wholly inside the period becomes its effective amount, while a
  // later-period report that excludes the original sees only the posted delta.
  const netBySource = new Map<string, { sourceKey: string; date: string; amount: number; metadata: PostedJournal['metadata'] }>();
  for (const j of journals.filter((entry) => inRange(entry, from, to))) {
    const amount = sum(j.lines.filter((l) => l.accountCode === '1000').map((l) => cents(l.debit - l.credit)));
    if (!amount) continue;
    const sourceKey = j.logicalSourceKey ?? j.sourceKey;
    const existing = netBySource.get(sourceKey);
    const latest = !existing || j.date >= existing.date;
    netBySource.set(sourceKey, {
      sourceKey,
      date: latest ? j.date : existing.date,
      amount: cents((existing?.amount ?? 0) + amount),
      metadata: latest ? j.metadata : existing.metadata,
    });
  }
  const entries = [...netBySource.values()]
    .filter((entry) => entry.amount !== 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.sourceKey.localeCompare(b.sourceKey));
  return { from: from ?? null, to: to ?? null, inflows: sum(entries.filter((x) => x.amount > 0).map((x) => x.amount)), outflows: cents(-sum(entries.filter((x) => x.amount < 0).map((x) => x.amount))), netCash: sum(entries.map((x) => x.amount)), entries };
}
export function repPayables(journals: PostedJournal[], asOf?: string) {
  const tb = trialBalance(journals, undefined, asOf);
  const row = tb.rows.find((r) => r.accountCode === '2000');
  const rows = journals.filter((j) => !asOf || j.date <= asOf).flatMap((j) => j.lines.filter((l) => l.accountCode === '2000').map((l) => ({
    journalId: j.id, sourceKey: j.sourceKey, sourceType: j.sourceType, date: j.date,
    repId: l.repId ?? (typeof j.metadata?.repId === 'string' ? j.metadata.repId : null),
    dealId: l.dealId ?? (typeof j.metadata?.dealId === 'string' ? j.metadata.dealId : j.sourceKey.split(':')[1] ?? null),
    accrual: l.credit, payoutOrRecovery: l.debit, endingEffect: cents(l.credit - l.debit),
  })));
  return { asOf: asOf ?? null, payable: row?.balance ?? 0, rows, drilldown: row?.journals ?? [] };
}