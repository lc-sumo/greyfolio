import { cents, sum } from './money.js';
import { clawbacksFor, repClawback } from './clawback.js';
import { dealLines, repDeals, repShare } from './splits.js';
import { standingLines, voidedKeys } from './void.js';
import type { Deal, LedgerContext, PayoutLine } from './types.js';

export interface RepLedger {
  deals: Deal[];
  /** Σ rep's share of every deal they are on, regardless of collection. */
  earned: number;
  /** Σ rep's share on commission the LENDER HAS PAID — increments received, upfronts collected. */
  accrued: number;
  /** earned − accrued: the rep's share still sitting with the lender. */
  awaitingLender: number;
  /** Σ positive ledger rows — GROSS settled. */
  paid: number;
  /** Σ ALL ledger rows — net of recoveries. */
  cash: number;
  /** Σ charged clawback slices that have not been recovered or forgiven. */
  held: number;
  /** Σ recovered slice over every clawback. */
  recovered: number;
  /**
   * Signed commission balance: accrued − effective positive payouts −
   * outstanding clawback liability. This is deliberately not clamped: a
   * clawback can put a rep into a negative balance.
   */
  balance: number;
  /** Cash currently payable. A negative balance is recovered from future earnings, not paid out. */
  payable: number;
  /** @deprecated Use `balance`; retained for existing consumers. */
  owed: number;
}

/**
 * THE ONE definition of a rep's money. The wallet, rep cards, admin roster,
 * and payroll netting must all read this and never re-derive any field.
 * "Paid" comes from the ledger — never from deal status. "Owed" accrues as the
 * lender pays: recording an increment moves that unit from awaitingLender to owed.
 */
export function repLedger(ctx: LedgerContext, repId: string): RepLedger {
  const deals = repDeals(ctx.deals, repId);
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const mine = ctx.lines.filter((l) => l.repId === repId);

  const earned = sum(deals.map((d) => repShare(d, repId)));
  const accrued = sum(deals.flatMap((d) => dealLines(d).filter((l) => l.repId === repId && l.collected).map((l) => l.amount)));
  const paid = sum(standingLines(mine).filter((l) => l.amount > 0).map((l) => l.amount));
  const cash = sum(mine.map((l) => l.amount)); // voids cancel their originals here
  const adjustments = sum((ctx.adjustments ?? []).filter((a) => a.repId === repId).map((a) => a.amount));

  let held = 0;
  let recovered = 0;
  for (const c of clawbacksFor(ctx.clawbacks, ctx.deals, repId)) {
    const slice = repClawback(c, byId.get(c.dealId), repId, ctx.lines);
    recovered += slice.recovered;
    // Recovery rows are authoritative. Do not rely on a persisted status here:
    // it can be stale while an append-only recovery/void is being reconciled.
    // `remaining` already excludes every standing recovery, so it is charged
    // exactly once.
    held += slice.remaining;
  }
  held = cents(held);
  recovered = cents(recovered);

  const balance = cents(accrued - paid - held + adjustments);
  return {
    deals, earned, accrued, awaitingLender: Math.max(0, cents(earned - accrued)),
    paid, cash, held, recovered, balance, payable: Math.max(0, balance),
    owed: balance,
  };
}

export interface PaidFigures {
  /** Never negative — only positive rows. */
  gross: number;
  /** Withholding, shown as its own line ("less $X clawback recovered"). */
  recovered: number;
  /** gross − recovered. */
  cash: number;
  lineCount: number;
  /** Commission reversed by voids in this set (informational). */
  voided: number;
}

/**
 * How to render "paid" for any set of ledger rows (a period, a run, a rep).
 * Sum only positive rows for the headline; surface withholding separately.
 */
export function paidFigures(lines: PayoutLine[], allLines: PayoutLine[] = lines): PaidFigures {
  // Voids are detected over the whole ledger: a payout inside a date window may have been voided outside it.
  const gone = voidedKeys(allLines);
  const stands = lines.filter((l) => l.role !== 'Void' && !gone.has(l.key));
  const pos = stands.filter((l) => l.amount > 0);
  const gross = sum(pos.map((l) => l.amount));
  const recovered = cents(-sum(stands.filter((l) => l.amount < 0).map((l) => l.amount)));
  const voided = sum(lines.filter((l) => l.role !== 'Void' && gone.has(l.key) && l.amount > 0).map((l) => l.amount));
  return { gross, recovered, cash: cents(gross - recovered), lineCount: pos.length, voided };
}

/** Ledger rows whose payout cleared inside [from, to] (inclusive ISO dates). */
export function linesInPeriod(lines: PayoutLine[], from: string, to: string): PayoutLine[] {
  return lines.filter((l) => l.paidAt >= from && l.paidAt <= to);
}

/**
 * Earned and paid are on DIFFERENT time axes: earned buckets by the month the
 * deal FUNDED; paid buckets by the month the payout CLEARED.
 */
export function monthlySeries(ctx: LedgerContext, repId: string, months: string[]): Array<{ month: string; earned: number; paid: number }> {
  const deals = repDeals(ctx.deals, repId);
  const mine = standingLines(ctx.lines).filter((l) => l.repId === repId && l.amount > 0);
  return months.map((month) => ({
    month,
    earned: sum(deals.filter((d) => d.date.startsWith(month)).map((d) => repShare(d, repId))),
    paid: sum(mine.filter((l) => l.paidAt.startsWith(month)).map((l) => l.amount)),
  }));
}
