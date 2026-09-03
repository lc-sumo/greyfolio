/** Live math for the new-deal form — the same chain the server runs, so the preview never disagrees with the saved deal. */
import { commissionFor, paybackOf, paymentFor } from '@greystone/commission';
import type { ProductRule, ReferralPartner } from './api';

export const num = (v: string | number | null | undefined) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
export const rate = (v: string | number | null | undefined) => {
  const n = num(v);
  return n > 1 ? n / 100 : n;
};

/** PSF can be typed as a % of the amount or as dollars; either way the deal stores the %. */
export function psfRateOf(f: Record<string, string>, amount: number): number {
  if (f.psfMode === '$') return amount > 0 ? num(f.psfDollars) / amount : 0;
  return rate(f.psfPct);
}

export function liveMath(f: Record<string, string>, rule: ProductRule | undefined, partner: ReferralPartner | undefined, referralPaidThisMonth = 0) {
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
    psfRate: psfRateOf(f, amount),
    originationFee: num(f.originationFee),
    referralRate: partner?.pct ?? 0,
    referralCap: partner?.monthlyCap ?? null,
    referralPaidThisMonth,
    openerRate: f.openerId ? rate(f.openerRate) : 0,
    closerRate: f.closerId ? rate(f.closerRate) : 0,
    overrideRate: f.overrideId ? rate(f.overrideRate) : 0,
  });
  const payback = rule?.factor || apr !== null ? paybackOf({ amount, factor, apr, termDays }) : null;
  const payment = paymentFor({ payback, termDays, frequency: f.frequency });
  const referralRaw = Math.round(Math.max(0, calc.gross) * (partner?.pct ?? 0) * 100) / 100;
  return { ...calc, payback, payment, termDays, psfRate: psfRateOf(f, amount), referralRaw, referralExcess: Math.max(0, Math.round((referralRaw - calc.referralFee) * 100) / 100), referralPaidThisMonth };
}

/** Estimated renewal / maturity in calendar days: business days × 1.4 (Mon–Fri only). */
export function addBusinessDays(iso: string, businessDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(businessDays * 1.4));
  return d.toISOString().slice(0, 10);
}
