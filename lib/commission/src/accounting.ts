import { scheduleEvents } from './collection.js';
import { clawbackSlices } from './clawback.js';
import { cents, sum } from './money.js';
import { segments } from './segments.js';
import { dealLines } from './splits.js';
import type { Clawback, Deal, PayoutLine, Segment } from './types.js';

/**
 * The small, dependency-free accounting kernel. Database adapters persist these
 * values; this module deliberately has no database knowledge so a projection is
 * repeatable in imports, jobs, and tests.
 */
export const SYSTEM_CHART = [
  { code: '1000', name: 'Cash', type: 'asset', purpose: 'cash' },
  { code: '1100', name: 'Lender commission A/R', type: 'asset', purpose: 'lender_ar' },
  { code: '1200', name: 'Rep recovery receivable', type: 'asset', purpose: 'rep_recovery_receivable' },
  { code: '2000', name: 'Rep payable', type: 'liability', purpose: 'rep_payable' },
  { code: '2010', name: 'Referral payable', type: 'liability', purpose: 'referral_payable' },
  { code: '3000', name: 'Opening equity', type: 'equity', purpose: 'opening_equity' },
  { code: '4000', name: 'Commission revenue', type: 'revenue', purpose: 'commission_revenue' },
  { code: '4090', name: 'Clawback contra-revenue/loss', type: 'revenue', purpose: 'clawback_loss' },
  { code: '5000', name: 'Rep commission expense', type: 'expense', purpose: 'rep_expense' },
  { code: '5010', name: 'Referral expense', type: 'expense', purpose: 'referral_expense' },
] as const;

export type SystemAccountCode = (typeof SYSTEM_CHART)[number]['code'];
export type AccountingAccountType = (typeof SYSTEM_CHART)[number]['type'];

export interface AccountingLine {
  accountCode: SystemAccountCode;
  debit: number;
  credit: number;
  memo?: string;
  /** Explicit reporting dimensions; never inferred from source keys at persistence time. */
  dealId?: string | null;
  repId?: string | null;
}

export interface AccountingJournal {
  /** A deterministic, source-derived key. It is the idempotency key in storage. */
  sourceKey: string;
  sourceType: string;
  date: string;
  memo: string;
  lines: AccountingLine[];
  /** Facts which need clear disclosure in an audit/report drilldown. */
  metadata?: Record<string, string | number | boolean | null>;
  /** Stable input fingerprint; changing an authoritative event creates a reversal upstream. */
  fingerprint: string;
}

export interface AccountingProjectionInput {
  deals: Deal[];
  payoutLines: PayoutLine[];
  clawbacks: Clawback[];
}

export interface AccountingProjection {
  journals: AccountingJournal[];
  /** Journals whose collection date is deterministic but not source-confirmed. */
  assumedCollectionDates: AccountingJournal[];
}

const asLine = (accountCode: SystemAccountCode, debit = 0, credit = 0, memo?: string, dimensions?: Pick<AccountingLine, 'dealId' | 'repId'>): AccountingLine => ({
  accountCode, debit: cents(debit), credit: cents(credit), ...(memo ? { memo } : {}), ...dimensions,
});

/** Throws rather than allowing a one-cent or malformed journal into persistence. */
export function assertBalanced(journal: Pick<AccountingJournal, 'sourceKey' | 'date' | 'lines'>): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(journal.date)) throw new Error(`Journal ${journal.sourceKey} has an invalid accounting date`);
  if (!journal.lines.length) throw new Error(`Journal ${journal.sourceKey} has no lines`);
  for (const line of journal.lines) {
    if (line.debit < 0 || line.credit < 0 || (line.debit === 0 && line.credit === 0) || (line.debit > 0 && line.credit > 0)) {
      throw new Error(`Journal ${journal.sourceKey} has an invalid debit/credit line`);
    }
  }
  const debits = sum(journal.lines.map((line) => line.debit));
  const credits = sum(journal.lines.map((line) => line.credit));
  if (debits !== credits) throw new Error(`Journal ${journal.sourceKey} is not balanced: ${debits.toFixed(2)} != ${credits.toFixed(2)}`);
}

/**
 * A portable deterministic fingerprint (not a security digest). Persistence
 * may hash this canonical value, but it must never depend on clock time/order.
 */
export function journalFingerprint(journal: Omit<AccountingJournal, 'fingerprint'>): string {
  return JSON.stringify({
    sourceKey: journal.sourceKey, sourceType: journal.sourceType, date: journal.date, memo: journal.memo,
    lines: journal.lines.map((l) => [l.accountCode, l.debit.toFixed(2), l.credit.toFixed(2), l.memo ?? '', l.dealId ?? '', l.repId ?? '']),
    metadata: journal.metadata ?? {},
  });
}

function journal(j: Omit<AccountingJournal, 'fingerprint'>): AccountingJournal {
  const complete = { ...j, fingerprint: journalFingerprint(j) };
  assertBalanced(complete);
  return complete;
}

function collectionJournals(deal: Deal, seg: Segment): AccountingJournal[] {
  const prefix = `collection:${deal.id}:${seg.sk}`;
  const dimensions = { dealId: deal.id };
  if (seg.schedule) {
    // Schedules hold expected dates, not received timestamps. They are used
    // deterministically and explicitly flagged until a source adds paid dates.
    return scheduleEvents(seg, '9999-12-31').filter((e) => e.received && e.amount > 0).map((e) => journal({
      sourceKey: `${prefix}:${e.kind}:${e.n}`, sourceType: 'lender_collection', date: e.expected ?? seg.date,
      memo: `Lender commission collection — ${deal.id} ${seg.label}`,
      lines: [asLine('1000', e.amount, 0, undefined, dimensions), asLine('1100', 0, e.amount, undefined, dimensions)],
      metadata: { collectionDateAssumed: true, deterministicDateRule: 'schedule expected date; segment funded date when absent' },
    }));
  }
  const amount = Math.max(0, cents(seg.collected ?? 0));
  if (!amount) return [];
  const authoritativeBaseDate = seg.sk === 'base' ? deal.lenderPaid : null;
  const partialAggregate = amount < cents(seg.gross);
  return [journal({
    sourceKey: prefix, sourceType: 'lender_collection', date: authoritativeBaseDate ?? seg.date,
    memo: `Lender commission collection — ${deal.id} ${seg.label}`,
    lines: [asLine('1000', amount, 0, undefined, dimensions), asLine('1100', 0, amount, undefined, dimensions)],
    metadata: authoritativeBaseDate
      ? { ...(partialAggregate ? { collectionDateAssumed: true, collectionDateUnresolved: true, deterministicDateRule: 'aggregate partial collection has no dated event history; using authoritative base receipt date' } : {}), authoritativeReceiptDate: true }
      : { collectionDateAssumed: true, deterministicDateRule: 'segment funded date (collection date unavailable)' },
  })];
}

/**
 * Projects only authoritative portal facts. It never writes or changes source
 * records. Re-running with the same input returns byte-for-byte same source
 * keys/fingerprints, allowing an adapter to insert-on-conflict-do-nothing.
 */
export function projectAccounting(input: AccountingProjectionInput): AccountingProjection {
  const out: AccountingJournal[] = [];
  for (const deal of [...input.deals].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const seg of segments(deal)) {
      if (seg.gross > 0) out.push(journal({
        sourceKey: `funding:${deal.id}:${seg.sk}`, sourceType: 'funding', date: seg.date,
        memo: `Commission earned — ${deal.id} ${seg.label}`,
        lines: [asLine('1100', seg.gross, 0, undefined, { dealId: deal.id }), asLine('4000', 0, seg.gross, undefined, { dealId: deal.id })],
      }));
      if (seg.referralFee > 0) out.push(journal({
        sourceKey: `referral-accrual:${deal.id}:${seg.sk}`, sourceType: 'referral_accrual', date: seg.date,
        memo: `Referral expense accrued — ${deal.id} ${seg.label}`,
        lines: [asLine('5010', seg.referralFee, 0, undefined, { dealId: deal.id }), asLine('2010', 0, seg.referralFee, undefined, { dealId: deal.id })],
      }));
      out.push(...collectionJournals(deal, seg));
    }
    const totalReferral = sum(segments(deal).map((s) => s.referralFee));
    if (deal.referralPaidAt && totalReferral > 0) out.push(journal({
      sourceKey: `referral-payment:${deal.id}`, sourceType: 'referral_payment', date: deal.referralPaidAt,
      memo: `Referral paid — ${deal.id}`,
      lines: [asLine('2010', totalReferral, 0, undefined, { dealId: deal.id }), asLine('1000', 0, totalReferral, undefined, { dealId: deal.id })],
    }));
    // Accrue the rep obligation only for collection units marked received.
    for (const line of dealLines(deal)) if (line.collected && line.amount > 0) {
      const authoritativeBaseDate = line.segment.sk === 'base' && !line.segment.schedule ? deal.lenderPaid : null;
      const date = authoritativeBaseDate ?? line.unit?.expected ?? line.segment.date;
      const partialAggregate = !line.segment.schedule && cents(line.segment.collected ?? 0) < cents(line.segment.gross);
      out.push(journal({
        sourceKey: `rep-accrual:${line.key}`, sourceType: 'rep_accrual', date,
        memo: `Rep commission accrued — ${deal.id} ${line.role}`,
        lines: [asLine('5000', line.amount, 0, undefined, { dealId: deal.id, repId: line.repId }), asLine('2000', 0, line.amount, undefined, { dealId: deal.id, repId: line.repId })],
        metadata: { dealId: deal.id, repId: line.repId, ...(authoritativeBaseDate
          ? (partialAggregate ? { collectionDateAssumed: true, collectionDateUnresolved: true, deterministicDateRule: 'aggregate partial collection has no dated event history; using authoritative base receipt date' } : { authoritativeReceiptDate: true })
          : { collectionDateAssumed: true, deterministicDateRule: line.unit?.expected ? 'schedule expected date' : 'segment funded date (collection date unavailable)' }) },
      }));
    }
  }
  const dealsById = new Map(input.deals.map((d) => [d.id, d]));
  for (const cb of [...input.clawbacks].sort((a, b) => a.id.localeCompare(b.id))) if (!cb.forgivenAt && cb.amount > 0) {
    const deal = dealsById.get(cb.dealId);
    const dimensions = { dealId: cb.dealId };
    out.push(journal({
      sourceKey: `clawback:${cb.id}`, sourceType: 'clawback', date: cb.date, memo: `Lender clawback — ${cb.dealId}`,
      lines: [asLine('4090', cb.amount, 0, undefined, dimensions), asLine('1100', 0, cb.amount, undefined, dimensions)], metadata: { dealId: cb.dealId, reason: cb.reason },
    }));
    for (const { repId, share: recoverable } of (deal ? clawbackSlices(cb, deal, []) : []).sort((a, b) => a.repId.localeCompare(b.repId))) {
      // Use the operational slice directly so account 1200 cannot diverge by
      // a cent from the liability shown and withheld for this rep.
      if (recoverable) out.push(journal({
        sourceKey: `clawback-recovery-accrual:${cb.id}:${repId}`, sourceType: 'rep_recovery_accrual', date: cb.date, memo: `Rep recovery receivable — ${cb.dealId}`,
        lines: [asLine('1200', recoverable, 0, undefined, { dealId: cb.dealId, repId }), asLine('4090', 0, recoverable, undefined, { dealId: cb.dealId, repId })],
        metadata: { dealId: cb.dealId, repId, clawbackId: cb.id },
      }));
    }
  }
  const payoutByKey = new Map(input.payoutLines.map((line) => [line.key, line]));
  const payoutEconomics = (line: PayoutLine, resolving = new Set<string>()): AccountingLine[] => {
    const dimensions = { dealId: line.dealId, repId: line.repId };
    if (line.role !== 'Void') {
      const amount = Math.abs(cents(line.amount));
      return line.amount < 0
        ? [asLine('1000', amount, 0, undefined, dimensions), asLine('1200', 0, amount, undefined, dimensions)]
        : [asLine('2000', amount, 0, undefined, dimensions), asLine('1000', 0, amount, undefined, dimensions)];
    }
    if (!line.voids) throw new Error(`Void payout ${line.key} does not reference an original payout`);
    if (resolving.has(line.key)) throw new Error(`Void payout cycle at ${line.key}`);
    const original = payoutByKey.get(line.voids);
    if (!original) throw new Error(`Void payout ${line.key} references missing payout ${line.voids}`);
    resolving.add(line.key);
    const originalLines = payoutEconomics(original, resolving);
    resolving.delete(line.key);
    // A void is the exact accounting inverse of the referenced journal. Do not
    // re-infer its accounts from the void row's positive amount or generic role.
    return originalLines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
  };
  for (const line of [...input.payoutLines].sort((a, b) => a.key.localeCompare(b.key))) {
    const amount = Math.abs(cents(line.amount));
    if (!amount && line.role !== 'Void') continue;
    const reversal = line.role === 'Void';
    out.push(journal({
      sourceKey: `payout:${line.key}`, sourceType: reversal ? 'payout_void' : line.amount < 0 ? 'clawback_recovery' : 'rep_payout', date: line.paidAt,
      memo: reversal ? `Rep payout reversal/recovery — ${line.dealId}` : `Rep payout — ${line.dealId}`,
      lines: payoutEconomics(line),
      metadata: { dealId: line.dealId, repId: line.repId, voids: line.voids ?? null, clawbackId: line.clawbackId },
    }));
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.sourceKey.localeCompare(b.sourceKey));
  return { journals: out, assumedCollectionDates: out.filter((j) => j.metadata?.collectionDateAssumed === true) };
}