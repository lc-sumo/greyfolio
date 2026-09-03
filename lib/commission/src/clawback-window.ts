/**
 * A lender's clawback policy applied to one deal: when the deal clears the
 * clawback window, so the house and the rep know the commission is safe.
 */
import { PAYMENTS_PER_TERM } from './commission.js';
import { addBusinessDays } from './renewals.js';
import type { ClawbackBasis, Deal, Lender, ProductRule } from './types.js';

export interface ClawbackWindow {
  basis: ClawbackBasis;
  count: number;
  /** Where the policy came from: the lender, the product (exempt), or the global default window. */
  source: 'lender' | 'product' | 'default';
  /** Date the deal is out of the window; null when there is nothing to clear. */
  clearsOn: string | null;
  cleared: boolean;
  /** Calendar days until `clearsOn`; 0 once cleared; null when there is no window. */
  daysLeft: number | null;
  label: string;
}

export interface ClawbackWindowContext {
  lender?: Lender | null;
  rule?: ProductRule | null;
  /** Settings › thresholds › clawbackWindowDays — used when the lender has no policy of its own. */
  defaultDays: number;
}

function addCalendarDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function calendarDaysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
}

/** Business days one merchant payment covers at the deal's frequency (Daily 1, Weekly 5, Bi-Weekly 10, Monthly 21). */
export function businessDaysPerPayment(frequency: string | null | undefined): number {
  const per = PAYMENTS_PER_TERM[frequency ?? 'Daily'] ?? PAYMENTS_PER_TERM.Daily!;
  return Math.max(1, Math.round(1 / per(1)));
}

export function clawbackWindow(deal: Pick<Deal, 'date' | 'frequency' | 'dealStatus'>, ctx: ClawbackWindowContext, today: string): ClawbackWindow {
  if (ctx.rule && !ctx.rule.clawback) {
    return { basis: 'none', count: 0, source: 'product', clearsOn: null, cleared: true, daysLeft: null, label: 'Exempt — product carries no clawback' };
  }
  const policy = ctx.lender?.clawback;
  if (policy?.basis === 'none') {
    return { basis: 'none', count: 0, source: 'lender', clearsOn: null, cleared: true, daysLeft: null, label: `No clawback — ${ctx.lender!.name} policy` };
  }
  const basis: ClawbackBasis = policy?.basis ?? 'days';
  const count = policy ? Math.max(0, Math.round(policy.count)) : Math.max(0, Math.round(ctx.defaultDays));
  const source = policy ? 'lender' : 'default';
  const clearsOn = basis === 'payments' ? addBusinessDays(deal.date, count * businessDaysPerPayment(deal.frequency)) : addCalendarDays(deal.date, count);
  const cleared = today >= clearsOn;
  const daysLeft = cleared ? 0 : calendarDaysBetween(today, clearsOn);
  const what = basis === 'payments' ? `${count} payments` : `${count} days`;
  const label = cleared ? `Cleared clawback · ${what}` : deal.dealStatus === 'Default' || deal.dealStatus === 'Slow Pay' ? `${deal.dealStatus} inside the ${what} window` : `In clawback window · ${daysLeft}d left of ${what}`;
  return { basis, count, source, clearsOn, cleared, daysLeft, label };
}
