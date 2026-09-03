/**
 * Voiding a payout. The ledger is append-only: a void is a new row that
 * reverses an earlier one (`voids` names it). A voided commission line is
 * payable again; a voided recovery gives the clawback its balance back.
 * Row keys stay unique across re-pays with a `#n` suffix, and every "paid"
 * question reads the base key of rows that stand.
 */
import { cents, sum } from './money.js';
import { clawbackRecovered, clawbackStatus } from './clawback.js';
import { isDealFullyPaid } from './splits.js';
import type { Clawback, LedgerContext, PayoutLine } from './types.js';

/** `F12|Opener|base|u3#2` → `F12|Opener|base|u3`. */
export function rowBase(key: string): string {
  const i = key.indexOf('#');
  return i < 0 ? key : key.slice(0, i);
}

export function isVoidRow(l: Pick<PayoutLine, 'role'>): boolean {
  return l.role === 'Void';
}

/** Exact row keys that a Void row has reversed. */
export function voidedKeys(lines: PayoutLine[]): Set<string> {
  const s = new Set<string>();
  for (const l of lines) if (l.role === 'Void' && l.voids) s.add(l.voids);
  return s;
}

/** Rows that still stand: not a void, and not reversed by one. */
export function standingLines(lines: PayoutLine[]): PayoutLine[] {
  const gone = voidedKeys(lines);
  return lines.filter((l) => l.role !== 'Void' && !gone.has(l.key));
}

/** A fresh, unique key for re-paying a line whose earlier row was voided. */
export function nextRowKey(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const k = `${base}#${n}`;
    if (!existing.has(k)) return k;
  }
}

export interface VoidRequest {
  repId: string;
  runId: string;
  /** Exact row keys to void; omit to void everything paid to the rep in the run. */
  keys?: string[];
  paidAt: string;
}

export interface VoidPlan {
  repId: string;
  runId: string;
  /** The Void rows to append. */
  lines: PayoutLine[];
  /** Amount of commission reversed (positive originals) and of recoveries given back. */
  reversed: number;
  recoveriesReturned: number;
  clawbackUpdates: Array<Pick<Clawback, 'id' | 'recovered' | 'status'>>;
  /** Deals whose repPaid stamp no longer holds. */
  dealsUnstamped: string[];
}

export class VoidError extends Error {}

export function planVoid(ctx: LedgerContext, req: VoidRequest): VoidPlan {
  const gone = voidedKeys(ctx.lines);
  const wanted = req.keys ? new Set(req.keys) : null;
  const originals = ctx.lines.filter((l) => l.repId === req.repId && l.runId === req.runId && l.role !== 'Void' && !gone.has(l.key) && (!wanted || wanted.has(l.key)));
  if (originals.length === 0) throw new VoidError('Nothing to void — those rows are not in this run for this rep, or are already voided');
  const existing = new Set(ctx.lines.map((l) => l.key));
  const lines: PayoutLine[] = originals.map((o) => {
    const key = nextRowKey(`void|${o.key}`, existing);
    existing.add(key);
    return { key, dealId: o.dealId, segmentKey: o.segmentKey, role: 'Void', repId: o.repId, amount: cents(-o.amount), runId: req.runId, clawbackId: o.clawbackId, paidAt: req.paidAt, voids: o.key };
  });
  const after = [...ctx.lines, ...lines];
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const clawbackUpdates: VoidPlan['clawbackUpdates'] = [];
  for (const id of new Set(originals.map((o) => o.clawbackId).filter((x): x is string => !!x))) {
    const c = ctx.clawbacks.find((x) => x.id === id);
    const deal = c ? byId.get(c.dealId) : undefined;
    if (c && deal) clawbackUpdates.push({ id, recovered: clawbackRecovered(after, id), status: clawbackStatus(c, deal, after) });
  }
  const touched = new Set(originals.map((o) => o.dealId));
  const dealsUnstamped = ctx.deals.filter((d) => touched.has(d.id) && d.repPaid && !isDealFullyPaid(d, after)).map((d) => d.id);
  return {
    repId: req.repId,
    runId: req.runId,
    lines,
    reversed: sum(originals.filter((o) => o.amount > 0).map((o) => o.amount)),
    recoveriesReturned: cents(-sum(originals.filter((o) => o.amount < 0).map((o) => o.amount))),
    clawbackUpdates,
    dealsUnstamped,
  };
}

export function applyVoid(ctx: LedgerContext, plan: VoidPlan): LedgerContext {
  const updates = new Map(plan.clawbackUpdates.map((u) => [u.id, u]));
  const unstamp = new Set(plan.dealsUnstamped);
  return {
    deals: ctx.deals.map((d) => (unstamp.has(d.id) ? { ...d, repPaid: null } : d)),
    lines: [...ctx.lines, ...plan.lines],
    clawbacks: ctx.clawbacks.map((c) => {
      const u = updates.get(c.id);
      return u ? { ...c, recovered: u.recovered, status: u.status } : c;
    }),
  };
}
