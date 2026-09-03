import { cents, clamp } from './money.js';
import { totalFunded } from './segments.js';
import type { Deal } from './types.js';

/* ---------- business-day calendar (Mon–Fri, no holidays — matches the sheet's WORKDAY) ---------- */

const DAY = 86_400_000;
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/** WORKDAY(start, n): n business days after start (n may be 0). */
export function addBusinessDays(iso: string, n: number): string {
  const d = utc(iso);
  let left = Math.max(0, Math.round(n));
  while (left > 0) {
    d.setTime(d.getTime() + DAY);
    if (!isWeekend(d)) left--;
  }
  return toIso(d);
}

/** Business days strictly after `from` up to and including `to` (0 when to <= from). */
export function businessDaysBetween(from: string, to: string): number {
  const a = utc(from);
  const b = utc(to);
  if (b <= a) return 0;
  let n = 0;
  for (let t = a.getTime() + DAY; t <= b.getTime(); t += DAY) if (!isWeekend(new Date(t))) n++;
  return n;
}

/** EDATE(start, months). */
export function addMonths(iso: string, months: number): string {
  const d = utc(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toIso(d);
}

/* ---------- renewals ---------- */

export type RenewalBucket = 'due' | 'soon' | 'building' | 'risk' | 'refinanced';

export interface Renewal {
  dealId: string;
  /** Share of the term paid in so far, 0–1. */
  pctPaidIn: number;
  /** Date the deal reaches the renewal mark (sheet: Est. Renewal). */
  markDate: string | null;
  maturityDate: string | null;
  /** Calendar days until the mark; negative once passed. */
  daysToMark: number | null;
  bucket: RenewalBucket;
  /** Gross commission if the merchant renews at the same size and rate. */
  estRenewalGross: number;
}

export interface RenewalSettings {
  renewalMark: number;
  soonDays?: number;
}

/**
 * Where a deal sits on the road to renewal. Monthly deals count the term in
 * months (EDATE); everything else counts business days (WORKDAY), exactly as
 * the workbook's `Est. Renewal (40% in)` and `Maturity Date` columns do.
 */
export function renewalOf(deal: Deal, settings: RenewalSettings, today: string): Renewal {
  const soonDays = settings.soonDays ?? 21;
  const term = deal.termDays ?? 0;
  const monthly = deal.frequency === 'Monthly';
  const markUnits = Math.round(term * settings.renewalMark);
  const markDate = term > 0 ? (monthly ? addMonths(deal.date, markUnits) : addBusinessDays(deal.date, markUnits)) : null;
  const maturityDate = term > 0 ? (monthly ? addMonths(deal.date, term) : addBusinessDays(deal.date, term)) : null;
  const elapsed = monthly ? monthsBetween(deal.date, today) : businessDaysBetween(deal.date, today);
  const pctPaidIn = term > 0 ? clamp(elapsed / term, 0, 1) : 0;
  const daysToMark = markDate ? Math.round((utc(markDate).getTime() - utc(today).getTime()) / DAY) : null;

  let bucket: RenewalBucket = 'building';
  if (deal.dealStatus === 'Refinanced' || deal.dealStatus === 'Paid In Full') bucket = 'refinanced';
  else if (deal.dealStatus === 'Default' || deal.dealStatus === 'Slow Pay') bucket = 'risk';
  else if (term > 0 && pctPaidIn >= settings.renewalMark) bucket = 'due';
  else if (daysToMark !== null && daysToMark <= soonDays) bucket = 'soon';

  return { dealId: deal.id, pctPaidIn: Math.round(pctPaidIn * 1000) / 1000, markDate, maturityDate, daysToMark, bucket, estRenewalGross: cents(totalFunded(deal) * deal.commRate) };
}

function monthsBetween(from: string, to: string): number {
  const a = utc(from);
  const b = utc(to);
  if (b <= a) return 0;
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return months + (b.getUTCDate() - a.getUTCDate()) / 30;
}

export const RENEWAL_BUCKET_LABEL: Record<RenewalBucket, string> = {
  due: 'Renewal ready',
  soon: 'Inside 21 days',
  building: 'Building',
  risk: 'Blocked',
  refinanced: 'Refinanced',
};
