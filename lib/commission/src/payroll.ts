import { nextRowKey } from './void.js';
import { cents, sum } from './money.js';
import { clawbackRecovered, clawbackStatus, clawbacksFor, repClawback } from './clawback.js';
import { repLedger } from './ledger.js';
import { isDealFullyPaid, payableLines, type RepLine } from './splits.js';
import type { Clawback, LedgerContext, PayoutLine } from './types.js';

export interface PayoutRequest {
  repId: string;
  /** Line keys the operator checked. */
  selectedKeys: string[];
  runId: string;
  /** `YYYY-MM-DD` — the date the payout clears. */
  paidAt: string;
}

export interface ClawbackUpdate {
  id: string;
  recovered: number;
  status: Clawback['status'];
}

export interface PayoutPlan {
  repId: string;
  runId: string;
  /** Positive rows — one per selected line. */
  lines: PayoutLine[];
  /** Negative rows — one per clawback recovered against this payout. */
  recoveries: PayoutLine[];
  clawbackUpdates: ClawbackUpdate[];
  gross: number;
  withheld: number;
  net: number;
  /** Deals whose every line is now settled — stamp `repPaid` on these. */
  dealsFullyPaid: string[];
  /** Deal ids among the selection where the lender has not fully paid the commission. */
  uncollectedDealIds: string[];
}

export class PayoutError extends Error {}

/** Base recovery row key; repeated partial recoveries receive an append-only suffix. */
export function recoveryKey(clawbackId: string, runId: string, repId: string): string {
  return `cbrec|${clawbackId}|${runId}|${repId}`;
}

/** Open clawbacks against a rep with something left to withhold, oldest first. */
export function clawbackQueue(ctx: LedgerContext, repId: string): Array<{ clawback: Clawback; remaining: number }> {
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  return clawbacksFor(ctx.clawbacks, ctx.deals, repId)
    .map((c) => ({ clawback: c, remaining: repClawback(c, byId.get(c.dealId), repId, ctx.lines).remaining }))
    .filter((x) => x.remaining > 0)
    .sort((a, b) => a.clawback.date.localeCompare(b.clawback.date) || a.clawback.id.localeCompare(b.clawback.id));
}

/** Preview of what a selection would pay — the dark selection footer. */
export function payoutPreview(ctx: LedgerContext, repId: string, selectedKeys: string[]): { gross: number; withheld: number; net: number; outstandingClawback: number } {
  const selected = selectLines(ctx, repId, selectedKeys);
  return payoutMath(ctx, repId, selected);
}

function selectLines(ctx: LedgerContext, repId: string, selectedKeys: string[]): RepLine[] {
  const wanted = new Set(selectedKeys);
  const payable = payableLines(ctx.deals, ctx.lines, repId);
  const byKey = new Map(payable.map((l) => [l.key, l]));
  const out: RepLine[] = [];
  for (const key of wanted) {
    const line = byKey.get(key);
    if (!line) {
      const paidAlready = ctx.lines.some((l) => l.key === key && l.amount > 0);
      throw new PayoutError(paidAlready ? `Line ${key} is already paid` : `Line ${key} is not payable to ${repId}`);
    }
    out.push(line);
  }
  return out;
}

/**
 * The single balance-aware calculation used by both preview and commit.
 *
 * `balance` is computed from the canonical ledger while holding the payout
 * lock. It already includes any collected selected units. A selection may
 * only produce cash to the extent the whole rep balance permits it; the
 * remainder must be recovered against an actual standing clawback liability.
 * This deliberately rejects an uncollected advance that cannot be offset,
 * rather than silently paying cash or manufacturing a recovery row.
 */
function payoutMath(ctx: LedgerContext, repId: string, selected: RepLine[]): { gross: number; withheld: number; net: number; outstandingClawback: number } {
  const gross = sum(selected.map((l) => l.amount));
  const outstandingClawback = sum(clawbackQueue(ctx, repId).map((q) => q.remaining));
  const balance = repLedger(ctx, repId).balance;
  const net = cents(Math.min(gross, Math.max(0, balance)));
  const withheld = cents(gross - net);
  if (withheld > outstandingClawback) {
    throw new PayoutError(`Selection requires ${withheld.toFixed(2)} of clawback recovery but only ${outstandingClawback.toFixed(2)} remains; uncollected advances cannot be paid as cash`);
  }
  return { gross, withheld, net, outstandingClawback };
}

/**
 * Plan a payout. Pure: returns the rows to append and the clawback roll-ups
 * to write; the caller commits them in one transaction and pins `repId` as
 * the payroll rep so the panel cannot re-target after the balance zeroes.
 *
 * Clawback recovery allocates oldest-first across the rep's open clawbacks,
 * writes one negative row per clawback touched, and never withholds more
 * than either the payout gross or each clawback's remaining slice — so a
 * recovery is collected exactly once.
 */
export function planPayout(ctx: LedgerContext, req: PayoutRequest): PayoutPlan {
  const selected = selectLines(ctx, req.repId, req.selectedKeys);
  if (selected.length === 0) throw new PayoutError('Select at least one deal line to pay');

  const math = payoutMath(ctx, req.repId, selected);
  const { gross } = math;
  const existing = new Set(ctx.lines.map((l) => l.key));
  const lines: PayoutLine[] = selected.map((l) => ({
    key: nextRowKey(l.key, existing),
    dealId: l.dealId,
    segmentKey: l.segmentKey,
    role: l.role,
    repId: l.repId,
    amount: l.amount,
    runId: req.runId,
    clawbackId: null,
    paidAt: req.paidAt,
  }));

  let toWithhold = math.withheld;
  const recoveries: PayoutLine[] = [];
  const clawbackUpdates: ClawbackUpdate[] = [];
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));

  for (const { clawback, remaining } of clawbackQueue(ctx, req.repId)) {
    if (toWithhold <= 0) break;
    const take = cents(Math.min(remaining, toWithhold));
    if (take <= 0) continue;
    toWithhold = cents(toWithhold - take);
    const key = nextRowKey(recoveryKey(clawback.id, req.runId, req.repId), existing);
    existing.add(key);
    recoveries.push({
      key,
      dealId: clawback.dealId,
      segmentKey: null,
      role: 'Clawback recovery',
      repId: req.repId,
      amount: -take,
      runId: req.runId,
      clawbackId: clawback.id,
      paidAt: req.paidAt,
    });
  }

  const after = [...ctx.lines, ...lines, ...recoveries];
  for (const r of recoveries) {
    const c = ctx.clawbacks.find((x) => x.id === r.clawbackId);
    const deal = c ? byId.get(c.dealId) : undefined;
    if (!c || !deal) continue;
    clawbackUpdates.push({ id: c.id, recovered: clawbackRecovered(after, c.id), status: clawbackStatus(c, deal, after) });
  }

  const withheld = cents(-sum(recoveries.map((r) => r.amount)));
  const touched = new Set(selected.map((l) => l.dealId));
  const dealsFullyPaid = ctx.deals.filter((d) => touched.has(d.id) && !d.repPaid && isDealFullyPaid(d, after)).map((d) => d.id);
  const uncollectedDealIds = [...new Set(selected.filter((l) => !l.collected).map((l) => l.dealId))];

  // Allocation must consume exactly the centralized required recovery.
  if (toWithhold !== 0) throw new PayoutError('Could not allocate the required clawback recovery');
  return { repId: req.repId, runId: req.runId, lines, recoveries, clawbackUpdates, gross, withheld, net: math.net, dealsFullyPaid, uncollectedDealIds };
}

/** Apply a plan to a context — what the database transaction does. Pure. */
export function applyPayout(ctx: LedgerContext, plan: PayoutPlan): LedgerContext {
  const updates = new Map(plan.clawbackUpdates.map((u) => [u.id, u]));
  const stamped = new Set(plan.dealsFullyPaid);
  const paidAt = plan.lines[0]?.paidAt ?? null;
  return {
    deals: ctx.deals.map((d) => (stamped.has(d.id) && !d.repPaid ? { ...d, repPaid: paidAt } : d)),
    lines: [...ctx.lines, ...plan.lines, ...plan.recoveries],
    clawbacks: ctx.clawbacks.map((c) => {
      const u = updates.get(c.id);
      return u ? { ...c, recovered: u.recovered, status: u.status } : c;
    }),
  };
}
