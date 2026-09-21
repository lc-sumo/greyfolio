/**
 * Incremental (consolidation) funding: the deal is entered at its planned
 * amount, disbursed in N increments, and the lender pays commission as each
 * increment goes out. The merchant may stop part-way; from then on the
 * "effective" plan is the increments that actually happened.
 */
import { cents, clamp } from './money.js';
import type { Deal, WeeklySchedule } from './types.js';

/** Increments still in the plan: the planned count, or where the merchant stopped. */
export function effectiveIncrements(s: WeeklySchedule): number {
  return s.stoppedAfter === null || s.stoppedAfter === undefined ? s.weeks : clamp(Math.round(s.stoppedAfter), 0, s.weeks);
}

export function isStopped(s: WeeklySchedule | null | undefined): boolean {
  return !!s && s.stoppedAfter !== null && s.stoppedAfter !== undefined;
}

/** The grid, if one is set and it fits the plan (one amount per increment, all positive). */
export function gridOf(s: WeeklySchedule | null | undefined): number[] | null {
  const g = s?.amounts;
  if (!g || g.length !== s!.weeks || g.length === 0 || g.some((a) => !(a >= 0)) || g.every((a) => a === 0)) return null;
  return g;
}

/** Each increment's share of the plan: equal without a grid, proportional to the grid with one. */
export function incrementWeights(s: WeeklySchedule): number[] {
  if (s.weeks <= 0) return [];
  const g = gridOf(s);
  if (!g) return Array.from({ length: s.weeks }, () => 1 / s.weeks);
  const total = g.reduce((a, b) => a + b, 0);
  return g.map((a) => a / total);
}

/** Share of the plan covered by the first `n` increments (0..1). */
export function shareThrough(s: WeeklySchedule, n: number): number {
  const w = incrementWeights(s);
  const k = clamp(Math.round(n), 0, w.length);
  let sum = 0;
  for (let i = 0; i < k; i++) sum += w[i]!;
  return Math.min(1, sum);
}

/** Share of the plan that stands: 1 while the plan is intact, the increments taken once stopped. */
export function disbursedRatio(s: WeeklySchedule | null | undefined): number {
  if (!s || s.weeks <= 0) return 1;
  if (!isStopped(s)) return 1;
  return s.stoppedFundingRatio === null || s.stoppedFundingRatio === undefined
    ? shareThrough(s, effectiveIncrements(s))
    : clamp(s.stoppedFundingRatio, 0, 1);
}

/** Parse a pasted grid: one amount per line or comma-separated, with `25000 x15` shorthand. */
export function parseIncrementGrid(text: string): number[] {
  const out: number[] = [];
  // A comma followed by exactly three digits is a thousands separator ("25,000"); any other comma separates amounts.
  const flat = text.replace(/,(?=\d{3}(?!\d))/g, '');
  for (const raw of flat.split(/[\n,;]+/)) {
    const t = raw.trim().replace(/\$/g, '');
    if (!t) continue;
    const m = /^([\d.,]+)\s*[x×*]\s*(\d+)$/i.exec(t.replace(/,/g, '')) ?? /^([\d.]+)\s*[x×*]\s*(\d+)$/i.exec(t);
    if (m) {
      const amt = Number(m[1]!.replace(/,/g, ''));
      const n = Number(m[2]);
      if (Number.isFinite(amt) && n > 0 && n <= 520) for (let i = 0; i < n; i++) out.push(cents(amt));
      continue;
    }
    const v = Number(t.replace(/,/g, ''));
    if (Number.isFinite(v) && v >= 0) out.push(cents(v));
  }
  return out;
}

/** Strict validator shared by portal and domain callers. Returns a reason rather than silently dropping tokens. */
export function validateIncrementGrid(textOrAmounts: string | number[], planned: number): string | null {
  if (!Number.isFinite(planned) || planned <= 0) return 'The planned funding amount must be finite and positive';
  if (typeof textOrAmounts === 'string' && textOrAmounts.trim() === '') return 'An increment grid is required';
  const amounts = typeof textOrAmounts === 'string' ? parseIncrementGrid(textOrAmounts) : textOrAmounts;
  if (!amounts.length) return 'Enter at least one increment amount';
  if (amounts.some((a) => !Number.isFinite(a) || a <= 0 || Math.abs(a * 100 - Math.round(a * 100)) > 1e-7)) return 'Every increment must be a positive exact-cent amount';
  const total = amounts.reduce((s, a) => s + Math.round(a * 100), 0);
  if (total !== Math.round(planned * 100)) return `The increment grid must total ${planned.toFixed(2)}`;
  if (typeof textOrAmounts === 'string') {
    const meaningful = textOrAmounts.replace(/,(?=\d{3}(?!\d))/g, '').split(/[\n,;]+/).filter((x) => x.trim());
    if (meaningful.length !== amounts.length && !meaningful.every((x) => /[\d.,$]+\s*[x×*]\s*\d+/i.test(x.trim()))) return 'The increment grid contains malformed amounts';
  }
  return null;
}

export interface IncrementParts {
  upfront: number;
  /** Commission per increment, on the PLANNED gross (spread structure); 0 when the rest is paid at the end. */
  perIncrement: number;
  /** Planned gross minus the upfront share. */
  rest: number;
  /** The at-end remainder for the increments that stand (0 when spread). */
  remainder: number;
  /** Gross the lender will actually pay: upfront + the rest scaled to the increments that stand. */
  effectiveGross: number;
}

export function incrementParts(plannedGross: number, s: WeeklySchedule): IncrementParts {
  const upfrontPct = clamp(s.upfrontPct ?? 0, 0, 1);
  const upfront = cents(plannedGross * upfrontPct);
  const rest = cents(plannedGross - upfront);
  const spread = (s.remainder ?? 'spread') === 'spread';
  const ratio = disbursedRatio(s);
  // Once a merchant opts out, total commission is repriced from the funding
  // actually received. The upfront payment is a credit against that amount,
  // not an additional fixed fee on top of prorated commission.
  const effectiveGross = cents(plannedGross * ratio);
  const restEffective = cents(Math.max(0, effectiveGross - upfront));
  return {
    upfront,
    rest,
    perIncrement: spread && s.weeks > 0 ? cents(rest / s.weeks) : 0,
    remainder: spread ? 0 : restEffective,
    effectiveGross,
  };
}

/** Commission the lender pays on increment `i` (1-based) — the rest of the gross in the grid's proportions (spread structure). */
export function incrementCommission(plannedGross: number, s: WeeklySchedule, i: number): number {
  const p = incrementParts(plannedGross, s);
  if ((s.remainder ?? 'spread') !== 'spread') return 0;
  const w = incrementWeights(s)[i - 1] ?? 0;
  const effective = effectiveIncrements(s);
  // Allocate the residual cent to the final effective unit. This makes the
  // event ledger conserve the exact post-upfront gross, including awkward
  // uneven grids and stopped plans.
  if (i === effective) {
    let prior = 0;
    for (let n = 1; n < i; n++) prior += cents(Math.max(0, p.effectiveGross - p.upfront) * (incrementWeights(s)[n - 1] ?? 0));
    return cents(Math.max(0, p.effectiveGross - p.upfront) - prior);
  }
  return cents(Math.max(0, p.effectiveGross - p.upfront) * w);
}

/** What the merchant is disbursed at increment `i` (1-based). */
export function incrementFunding(plannedAmount: number, s: WeeklySchedule, i: number): number {
  const w = incrementWeights(s)[i - 1] ?? 0;
  return cents(plannedAmount * w);
}

/** Funding progress of an incremental segment: how much has gone out to the merchant so far. */
export function disbursementOf(plannedAmount: number, s: WeeklySchedule | null | undefined): { planned: number; perIncrement: number; disbursed: number; final: number; count: number; total: number; stopped: boolean; uneven: boolean; manual?: true } | null {
  if (!s || s.weeks <= 0) return null;
  const total = effectiveIncrements(s);
  const count = clamp(s.received, 0, total);
  const grid = gridOf(s);
  const uneven = !!grid && grid.some((amount) => Math.abs(amount - grid[0]!) > 0.005);
  const manual = isStopped(s) && s.stoppedFundingRatio !== null && s.stoppedFundingRatio !== undefined;
  return {
    planned: plannedAmount,
    perIncrement: manual ? 0 : grid ? incrementFunding(plannedAmount, s, count + 1) || incrementFunding(plannedAmount, s, count) : cents(plannedAmount / s.weeks),
    disbursed: cents(plannedAmount * (isStopped(s) ? disbursedRatio(s) : shareThrough(s, count))),
    final: cents(plannedAmount * disbursedRatio(s)),
    count,
    total,
    stopped: isStopped(s),
    uneven,
    ...(manual ? { manual: true as const } : {}),
  };
}

/** The deal's payback scaled to what was actually disbursed (the plan's payback while the plan stands). */
export function dealPayback(deal: Pick<Deal, 'payback' | 'commSchedule'>): number | null {
  return deal.payback === null || deal.payback === undefined ? null : cents(deal.payback * disbursedRatio(deal.commSchedule));
}
