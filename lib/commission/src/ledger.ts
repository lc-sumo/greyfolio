import { cents, sum } from './money.js';
import { clawbacksFor, repClawback } from './clawback.js';
import { repDeals, repShare } from './splits.js';
import type { Deal, LedgerContext, PayoutLine } from './types.js';

export interface RepLedger {
  deals: Deal[];
  /** Σ rep's share of every deal they are on, regardless of collection. */
  earned: number;
  /** Σ positive ledger rows — GROSS settled. */
  paid: number;
  /** Σ ALL ledger rows — net of recoveries. */
  cash: number;
  /** Σ remaining slice over OPEN clawbacks. */
  held: number;
  /** Σ recovered slice over every clawback. */
  recovered: number;
  /** max(0, earned − paid − held). Nets against settled GROSS, never cash. */
  owed: number;
}

/**
 * THE ONE definition of a rep's money. The wallet, rep cards, admin roster,
 * and payroll netting must all read this and never re-derive any field.
 * "Paid" comes from the ledger — never from deal status.
 */
export function repLedger(ctx: LedgerContext, repId: string): RepLedger {
  const deals = repDeals(ctx.deals, repId);
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const mine = ctx.lines.filter((l) => l.repId === repId);

  const earned = sum(deals.map((d) => repShare(d, repId)));
  const paid = sum(mine.filter((l) => l.amount > 0).map((l) => l.amount));
  const cash = sum(mine.map((l) => l.amount));

  let held = 0;
  let recovered = 0;
  for (const c of clawbacksFor(ctx.clawbacks, ctx.deals, repId)) {
    const slice = repClawback(c, byId.get(c.dealId), repId, ctx.lines);
    recovered += slice.recovered;
    if (c.status === 'open') held += slice.remaining;
  }
  held = cents(held);
  recovered = cents(recovered);

  return { deals, earned, paid, cash, held, recovered, owed: Math.max(0, cents(earned - paid - held)) };
}

export interface PaidFigures {
  /** Never negative — only positive rows. */
  gross: number;
  /** Withholding, shown as its own line ("less $X clawback recovered"). */
  recovered: number;
  /** gross − recovered. */
  cash: number;
  lineCount: number;
}

/**
 * How to render "paid" for any set of ledger rows (a period, a run, a rep).
 * Sum only positive rows for the headline; surface withholding separately.
 */
export function paidFigures(lines: PayoutLine[]): PaidFigures {
  const pos = lines.filter((l) => l.amount > 0);
  const gross = sum(pos.map((l) => l.amount));
  const recovered = cents(-sum(lines.filter((l) => l.amount < 0).map((l) => l.amount)));
  return { gross, recovered, cash: cents(gross - recovered), lineCount: pos.length };
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
  const mine = ctx.lines.filter((l) => l.repId === repId && l.amount > 0);
  return months.map((month) => ({
    month,
    earned: sum(deals.filter((d) => d.date.startsWith(month)).map((d) => repShare(d, repId))),
    paid: sum(mine.filter((l) => l.paidAt.startsWith(month)).map((l) => l.amount)),
  }));
}
