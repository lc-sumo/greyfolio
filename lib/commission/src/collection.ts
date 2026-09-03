import { effectiveIncrements, incrementParts } from './increments.js';
import { cents, clamp, sum } from './money.js';
import { segments } from './segments.js';
import type { CommissionStatus, Deal, Lender, Segment, WeeklySchedule } from './types.js';

/** The weekly schedule on a segment, or `null` when it collects upfront. */
export function schedOf(seg: Pick<Segment, 'schedule'> | null | undefined): WeeklySchedule | null {
  const s = seg?.schedule;
  return s && s.mode === 'weekly' && s.weeks > 0 ? s : null;
}

/** The three money parts of a scheduled segment. */
export function scheduleParts(gross: number, s: WeeklySchedule): { upfront: number; perIncrement: number; remainder: number; rest: number } {
  const p = incrementParts(gross, s);
  return { upfront: p.upfront, rest: p.rest, perIncrement: p.perIncrement, remainder: p.remainder };
}

/** The gross a schedule was priced on — the planned figure when the merchant has since stopped. */
function plannedGrossOf(seg: Pick<Segment, 'gross'> & { planned?: Segment['planned'] }): number {
  return seg.planned?.gross ?? seg.gross;
}

/**
 * Collection is ONE quantity: dollars received from the lender.
 * Scheduled segments derive it from what has landed — the upfront share,
 * increments received, and the at-end remainder; others carry it
 * explicitly. There is no status fallback — status is derived from this.
 */
export function collectedOf(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>): number {
  const s = schedOf(seg);
  if (s) {
    const parts = scheduleParts(plannedGrossOf(seg), s);
    const eff = effectiveIncrements(s);
    let got = s.upfrontReceived ? parts.upfront : 0;
    if ((s.remainder ?? 'spread') === 'spread') got += cents(parts.rest * (clamp(s.received, 0, eff) / s.weeks));
    else if (s.remainderReceived) got += parts.remainder;
    return cents(clamp(got, 0, seg.gross));
  }
  if (typeof seg.collected === 'number') return cents(clamp(seg.collected, 0, seg.gross));
  return 0;
}

export function outstandingOf(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>): number {
  return cents(Math.max(0, seg.gross - collectedOf(seg)));
}

/** Commission status is a FUNCTION of collection, never a peer field. */
export function statusFor(collected: number, gross: number): CommissionStatus {
  if (gross > 0 && collected >= gross) return 'YES - Paid In Full';
  return collected > 0 ? 'Partially Paid' : 'Waiting for payment';
}

export function segmentStatus(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>): CommissionStatus {
  return statusFor(collectedOf(seg), seg.gross);
}

/** `14/20 wks`, `½ + 3/10 wks`, `10/10 · final due`, `Collected`, `Part collected`, or `Not collected`. */
export function collectionLabel(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>): string {
  const s = schedOf(seg);
  if (s) {
    const eff = effectiveIncrements(s);
    const stopped = eff !== s.weeks ? ' · opted out' : '';
    if (collectedOf(seg) >= seg.gross && seg.gross > 0) return `${eff}/${eff} wks${stopped}`;
    const unit = (s.cadenceDays ?? 7) === 7 ? 'wks' : 'incr.';
    const up = (s.upfrontPct ?? 0) > 0 ? `${s.upfrontReceived ? '' : '(no) '}${Math.round((s.upfrontPct ?? 0) * 100)}% up + ` : '';
    const tail = (s.remainder ?? 'spread') === 'at-end' && s.received >= eff && !s.remainderReceived ? ' · final due' : '';
    return `${up}${clamp(s.received, 0, eff)}/${eff} ${unit}${tail}${stopped}`;
  }
  const c = collectedOf(seg);
  if (!c) return 'Not collected';
  return c >= seg.gross ? 'Collected' : 'Part collected';
}

export function collectedGross(deal: Deal): number {
  return sum(segments(deal).map(collectedOf));
}

export function outstandingGross(deal: Deal): number {
  return sum(segments(deal).map(outstandingOf));
}

/** A deal's headline status: derived from its segments, never stored. */
export function dealCommissionStatus(deal: Deal): CommissionStatus {
  return statusFor(collectedGross(deal), totalGrossOf(deal));
}

function totalGrossOf(deal: Deal): number {
  return sum(segments(deal).map((s) => s.gross));
}

/** The patch a collection write produces on a segment's stored fields. */
export interface CollectionPatch {
  collected: number | null;
  schedule: WeeklySchedule | null;
}

/**
 * THE single writer for collection. Returns the stored fields a segment
 * must carry so that `collectedOf` reads back `dollars` (as closely as a
 * weekly schedule can represent it). Scheduled segments store weeks, not
 * dollars, so the two representations can never disagree.
 */
export function withCollection(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>, dollars: number): CollectionPatch {
  const amt = cents(clamp(dollars, 0, seg.gross));
  const s = schedOf(seg);
  if (s) {
    const parts = scheduleParts(seg.gross, s);
    const upfrontReceived = parts.upfront > 0 ? amt >= parts.upfront - 0.005 : s.upfrontReceived ?? false;
    const afterUpfront = Math.max(0, amt - (upfrontReceived ? parts.upfront : 0));
    if ((s.remainder ?? 'spread') === 'spread') {
      const received = parts.rest > 0 ? Math.round((afterUpfront / parts.rest) * s.weeks) : 0;
      return { collected: null, schedule: { ...s, upfrontReceived, received: clamp(received, 0, s.weeks) } };
    }
    const remainderReceived = afterUpfront >= parts.rest - 0.005 && parts.rest > 0;
    return { collected: null, schedule: { ...s, upfrontReceived, remainderReceived, received: remainderReceived ? s.weeks : s.received } };
  }
  return { collected: amt, schedule: null };
}

/** Record the upfront share as received (or not). */
export function withUpfront(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>, received: boolean): CollectionPatch | null {
  const s = schedOf(seg);
  if (!s || !(s.upfrontPct ?? 0)) return null;
  return { collected: null, schedule: { ...s, upfrontReceived: received } };
}

/** Record the at-end remainder as received (or not). */
export function withRemainder(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>, received: boolean): CollectionPatch | null {
  const s = schedOf(seg);
  if (!s || (s.remainder ?? 'spread') !== 'at-end') return null;
  return { collected: null, schedule: { ...s, remainderReceived: received } };
}

export type ScheduleEventKind = 'upfront' | 'increment' | 'remainder';
export interface ScheduleEvent {
  kind: ScheduleEventKind;
  /** 0 for upfront, 1..weeks for increments, weeks + 1 for the remainder. */
  n: number;
  label: string;
  expected: string | null;
  amount: number;
  received: boolean;
  /** Expected before `today` and not yet received. */
  overdue: boolean;
}

/**
 * When to expect each lender receipt: the upfront at funding, increments
 * every `cadenceDays` from `startDate`, and the at-end remainder after the
 * last increment. Used by the schedule card, the overdue flags and the
 * "expected in the next N days" bookkeeping figures.
 */
export function scheduleEvents(seg: Pick<Segment, 'gross' | 'collected' | 'schedule' | 'date'>, today: string): ScheduleEvent[] {
  const s = schedOf(seg);
  if (!s) return [];
  const parts = scheduleParts(plannedGrossOf(seg), s);
  const eff = effectiveIncrements(s);
  const cadence = s.cadenceDays ?? 7;
  const start = s.startDate ?? seg.date;
  const at = (i: number) => (start ? new Date(new Date(`${start}T00:00:00Z`).getTime() + i * cadence * 86_400_000).toISOString().slice(0, 10) : null);
  const out: ScheduleEvent[] = [];
  if (parts.upfront > 0) out.push({ kind: 'upfront', n: 0, label: 'Upfront', expected: seg.date, amount: parts.upfront, received: !!s.upfrontReceived, overdue: !s.upfrontReceived && seg.date < today });
  for (let i = 1; i <= eff; i++) {
    const expected = at(i - 1);
    const received = i <= s.received;
    out.push({ kind: 'increment', n: i, label: `Increment ${i}`, expected, amount: parts.perIncrement, received, overdue: !received && expected !== null && expected < today });
  }
  if (parts.remainder > 0) {
    const expected = at(eff);
    out.push({ kind: 'remainder', n: s.weeks + 1, label: 'Final (when increments done)', expected, amount: parts.remainder, received: !!s.remainderReceived, overdue: !s.remainderReceived && expected !== null && expected < today });
  }
  return out;
}

/** Dollars expected from the lender in [from, to] that have not landed, across the given segments. */
export function expectedBetween(segs: Array<Pick<Segment, 'gross' | 'collected' | 'schedule' | 'date'>>, from: string, to: string, today: string): { amount: number; count: number; overdue: number } {
  let amount = 0;
  let count = 0;
  let overdue = 0;
  for (const seg of segs) {
    for (const e of scheduleEvents(seg, today)) {
      if (e.received || !e.expected) continue;
      if (e.overdue) overdue = cents(overdue + e.amount);
      if (e.expected >= from && e.expected <= to) {
        amount = cents(amount + e.amount);
        count++;
      }
    }
  }
  return { amount, count, overdue };
}

/**
 * The status dropdown must WRITE COLLECTION, not set a status alongside it.
 * `Partially Paid` without an explicit figure is ambiguous (open question #7);
 * callers should pass `partialDollars` when ops keyed in an amount, else the
 * segment keeps whatever partial figure it already had (or half, as a last resort).
 */
export function withStatus(
  seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>,
  status: CommissionStatus,
  partialDollars?: number,
): CollectionPatch {
  if (status === 'YES - Paid In Full') return withCollection(seg, seg.gross);
  if (status === 'Partially Paid') {
    const current = collectedOf(seg);
    const target = partialDollars ?? (current > 0 && current < seg.gross ? current : seg.gross / 2);
    return withCollection(seg, clamp(target, 0.01, Math.max(0.01, seg.gross - 0.01)));
  }
  return withCollection(seg, 0);
}

/** Record (or reverse, with a negative delta) weekly increments on a scheduled segment. */
export function recordWeek(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>, delta = 1): CollectionPatch | null {
  const s = schedOf(seg);
  if (!s) return null;
  return { collected: null, schedule: { ...s, received: clamp((s.received || 0) + delta, 0, effectiveIncrements(s)) } };
}

/**
 * The merchant opted out of the rest of the plan: the increments received so
 * far are the increments there will be. `false` reopens the full plan.
 */
export function withStopped(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>, stopped: boolean): CollectionPatch | null {
  const s = schedOf(seg);
  if (!s) return null;
  if (!stopped) return { collected: null, schedule: { ...s, stoppedAfter: null } };
  return { collected: null, schedule: { ...s, stoppedAfter: clamp(s.received || 0, 0, s.weeks) } };
}

export interface ScheduleOptions {
  /** Number of increments; defaults to the lender's. */
  increments?: number | null;
  /** 0–1 (or 0–100). */
  upfrontPct?: number | null;
  remainder?: 'spread' | 'at-end' | null;
  cadenceDays?: number | null;
  /** First increment expected; defaults to funded date + one cadence. */
  startDate?: string | null;
}

/**
 * Build the schedule a new segment carries. A weekly lender always gets one
 * (with the lender's defaults); any lender gets one when the deal explicitly
 * asks for increments. Returns `null` for a plain upfront payout.
 */
export function scheduleFor(lender: Lender | null | undefined, fundedDate: string | null, opts: ScheduleOptions = {}): WeeklySchedule | null {
  const weekly = !!lender && lender.terms === 'weekly' && lender.weeks > 0;
  const weeks = Math.round(opts.increments ?? (weekly ? lender!.weeks : 0));
  if (!(weeks > 0)) return null;
  const rawUp = opts.upfrontPct ?? lender?.upfrontPct ?? 0;
  const upfrontPct = clamp(rawUp > 1 ? rawUp / 100 : rawUp, 0, 1);
  const cadenceDays = Math.max(1, Math.round(opts.cadenceDays ?? lender?.cadenceDays ?? 7));
  const startDate = opts.startDate ?? (fundedDate ? new Date(new Date(`${fundedDate}T00:00:00Z`).getTime() + cadenceDays * 86_400_000).toISOString().slice(0, 10) : null);
  const remainder = opts.remainder ?? lender?.remainder ?? 'spread';
  const s: WeeklySchedule = { mode: 'weekly', weeks, received: 0, startDate, cadenceDays, remainder };
  if (upfrontPct > 0) {
    s.upfrontPct = upfrontPct;
    s.upfrontReceived = false;
  }
  if (remainder === 'at-end') s.remainderReceived = false;
  return s;
}
