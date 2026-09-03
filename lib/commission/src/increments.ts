/**
 * Incremental (consolidation) funding: the deal is entered at its planned
 * amount, disbursed in N increments, and the lender pays commission as each
 * increment goes out. The merchant may stop part-way; from then on the
 * "effective" plan is the increments that actually happened.
 */
import { cents, clamp } from './money.js';
import type { WeeklySchedule } from './types.js';

/** Increments still in the plan: the planned count, or where the merchant stopped. */
export function effectiveIncrements(s: WeeklySchedule): number {
  return s.stoppedAfter === null || s.stoppedAfter === undefined ? s.weeks : clamp(Math.round(s.stoppedAfter), 0, s.weeks);
}

export function isStopped(s: WeeklySchedule | null | undefined): boolean {
  return !!s && s.stoppedAfter !== null && s.stoppedAfter !== undefined;
}

/** Share of the plan that stands: 1 while the plan is intact, increments-taken ÷ planned once stopped. */
export function disbursedRatio(s: WeeklySchedule | null | undefined): number {
  if (!s || s.weeks <= 0) return 1;
  return isStopped(s) ? effectiveIncrements(s) / s.weeks : 1;
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
  const restEffective = cents(rest * ratio);
  return {
    upfront,
    rest,
    perIncrement: spread && s.weeks > 0 ? cents(rest / s.weeks) : 0,
    remainder: spread ? 0 : restEffective,
    effectiveGross: cents(upfront + restEffective),
  };
}

/** Funding progress of an incremental segment: how much has gone out to the merchant so far. */
export function disbursementOf(plannedAmount: number, s: WeeklySchedule | null | undefined): { planned: number; perIncrement: number; disbursed: number; final: number; count: number; total: number; stopped: boolean } | null {
  if (!s || s.weeks <= 0) return null;
  const perIncrement = cents(plannedAmount / s.weeks);
  const total = effectiveIncrements(s);
  const count = clamp(s.received, 0, total);
  return { planned: plannedAmount, perIncrement, disbursed: cents(perIncrement * count), final: cents(plannedAmount * disbursedRatio(s)), count, total, stopped: isStopped(s) };
}
