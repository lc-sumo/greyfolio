import { cents, clamp, sum } from './money.js';
import { segments } from './segments.js';
import type { CommissionStatus, Deal, Lender, Segment, WeeklySchedule } from './types.js';

/** The weekly schedule on a segment, or `null` when it collects upfront. */
export function schedOf(seg: Pick<Segment, 'schedule'> | null | undefined): WeeklySchedule | null {
  const s = seg?.schedule;
  return s && s.mode === 'weekly' && s.weeks > 0 ? s : null;
}

/**
 * Collection is ONE quantity: dollars received from the lender.
 * Scheduled segments derive it from weeks received; others carry it
 * explicitly. There is no status fallback — status is derived from this.
 */
export function collectedOf(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>): number {
  const s = schedOf(seg);
  if (s) return cents(seg.gross * (clamp(s.received, 0, s.weeks) / s.weeks));
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

/** `14/20 wks`, `Collected`, `Part collected`, or `Not collected`. */
export function collectionLabel(seg: Pick<Segment, 'gross' | 'collected' | 'schedule'>): string {
  const s = schedOf(seg);
  if (s) return `${clamp(s.received, 0, s.weeks)}/${s.weeks} wks`;
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
    const received = seg.gross > 0 ? Math.round((amt / seg.gross) * s.weeks) : 0;
    return { collected: null, schedule: { ...s, received: clamp(received, 0, s.weeks) } };
  }
  return { collected: amt, schedule: null };
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
  return { collected: null, schedule: { ...s, received: clamp((s.received || 0) + delta, 0, s.weeks) } };
}

/** Build the schedule a new segment carries for a lender, or `null` for upfront terms. */
export function scheduleFor(lender: Lender | null | undefined, startDate: string | null): WeeklySchedule | null {
  if (!lender || lender.terms !== 'weekly' || !(lender.weeks > 0)) return null;
  return { mode: 'weekly', weeks: lender.weeks, received: 0, startDate };
}
