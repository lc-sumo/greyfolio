/** Live math for the new-deal form — the same chain the server runs, so the preview never disagrees with the saved deal. */
import { commissionFor, paybackOf } from '@greystone/commission';
import type { ProductRule, ReferralPartner } from './api';

export const num = (v: string | number | null | undefined) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
export const rate = (v: string | number | null | undefined) => {
  const n = num(v);
  return n > 1 ? n / 100 : n;
};

export function liveMath(f: Record<string, string>, rule: ProductRule | undefined, partner: ReferralPartner | undefined) {
  const amount = num(f.amount);
  const factor = rule?.factor ? num(f.factor) || null : null;
  const apr = rule && !rule.factor ? num(f.apr) || null : null;
  const termDays = rule?.term ? num(f.termDays) || null : null;
  const calc = commissionFor({
    amount,
    basis: rule?.basis ?? 'funded',
    factor,
    apr,
    termDays,
    commissionRate: rate(f.commRate),
    psfRate: rate(f.psfPct),
    originationFee: num(f.originationFee),
    referralRate: rate(f.referralRate),
    referralCap: partner?.monthlyCap ?? null,
    openerRate: f.openerId ? rate(f.openerRate) : 0,
    closerRate: f.closerId ? rate(f.closerRate) : 0,
    overrideRate: f.overrideId ? rate(f.overrideRate) : 0,
  });
  const payback = rule?.factor || apr !== null ? paybackOf({ amount, factor, apr, termDays }) : null;
  return { ...calc, payback, termDays };
}

/** Estimated renewal / maturity in calendar days: business days × 1.4 (Mon–Fri only). */
export function addBusinessDays(iso: string, businessDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(businessDays * 1.4));
  return d.toISOString().slice(0, 10);
}
