import { commissionFor } from './commission.js';
import { scheduleFor } from './collection.js';
import { asRate, cents } from './money.js';
import type { Deal, Lender, ProductRule, ReferralPartner } from './types.js';
import { ValidationError, validateNewDeal } from './validate.js';

/** What the new-deal form submits. Rates may be fractions (0.12) or percents (12). */
export interface NewDealDraft {
  business: string;
  merchantContact?: string;
  merchantEmail?: string;
  merchantPhone?: string;
  fundedDate: string;
  lender: string;
  product: string;
  parentId?: string | null;
  amount: number;
  termDays?: number | null;
  factor?: number | null;
  apr?: number | null;
  frequency?: string;
  commRate?: number | null;
  psfPct?: number | null;
  originationFee?: number | null;
  referralPartner?: string | null;
  referralRate?: number | null;
  creditLine?: number | null;
  drawInitialPct?: number | null;
  drawSubsequentPct?: number | null;
  openerId?: string | null;
  openerRate?: number | null;
  closerId?: string | null;
  closerRate?: number | null;
  overrideId?: string | null;
  overrideRate?: number | null;
  leadSource?: string | null;
  notes?: string | null;
  crmId?: string | null;
}

export interface PricingContext {
  id: string;
  today: string;
  rule: ProductRule | undefined;
  lender: Lender | undefined;
  partner: ReferralPartner | undefined;
  /** Referral fees already paid to this partner this month, for the cap. */
  referralPaidThisMonth?: number;
}

/**
 * Turn a form draft into a stored deal: validate the guards, apply the
 * product rule (factor vs APR, term, multi-draw), run the commission chain
 * and attach the lender's collection schedule. Throws `ValidationError`.
 */
export function priceDeal(draft: NewDealDraft, ctx: PricingContext): Deal {
  const errors = validateNewDeal(
    { business: draft.business, fundedDate: draft.fundedDate, lender: draft.lender, amount: draft.amount, product: draft.product, parentId: draft.parentId ?? null },
    ctx.rule,
    ctx.today,
  );
  if (!ctx.lender && draft.lender?.trim()) errors.push(`Unknown lender "${draft.lender}"`);
  if (draft.referralPartner && draft.referralPartner !== 'None' && !ctx.partner) errors.push(`Unknown referral partner "${draft.referralPartner}"`);
  if (errors.length) throw new ValidationError(errors);
  const rule = ctx.rule!;

  const factor = rule.factor ? draft.factor ?? null : null;
  const apr = rule.factor ? null : draft.apr ?? null;
  const termDays = rule.term ? draft.termDays ?? null : null;
  const commRate = asRate(draft.commRate ?? (rule.multiDraw ? rule.drawInitial : rule.comm));
  const psfPct = asRate(draft.psfPct);
  const originationFee = cents(draft.originationFee ?? 0);
  const partnerRate = ctx.partner ? ctx.partner.pct : 0;
  const referralRate = draft.referralRate === null || draft.referralRate === undefined ? partnerRate : asRate(draft.referralRate);
  const openerRate = draft.openerId ? asRate(draft.openerRate) : 0;
  const closerRate = draft.closerId ? asRate(draft.closerRate) : 0;
  const overrideRate = draft.overrideId ? asRate(draft.overrideRate) : 0;

  const calc = commissionFor({
    amount: draft.amount,
    basis: rule.basis,
    factor,
    apr,
    termDays,
    commissionRate: commRate,
    psfRate: psfPct,
    originationFee,
    referralRate,
    referralCap: ctx.partner?.monthlyCap ?? null,
    referralPaidThisMonth: ctx.referralPaidThisMonth,
    openerRate,
    closerRate,
    overrideRate,
  });
  const schedule = scheduleFor(ctx.lender, draft.fundedDate);

  return {
    id: ctx.id,
    opportunityId: draft.parentId || ctx.id,
    parentId: draft.parentId || null,
    date: draft.fundedDate,
    business: draft.business.trim(),
    merchantContact: draft.merchantContact?.trim() ?? '',
    merchantEmail: draft.merchantEmail?.trim().toLowerCase() ?? '',
    merchantPhone: draft.merchantPhone?.trim() ?? '',
    lender: draft.lender,
    product: draft.product,
    funded: cents(draft.amount),
    factor,
    apr,
    termDays,
    frequency: draft.frequency || 'Daily',
    payback: rule.factor || apr !== null ? calc.payback : null,
    commRate,
    psfPct,
    originationFee,
    referralPartner: referralRate > 0 && ctx.partner ? ctx.partner.name : null,
    referralRate,
    gross: calc.gross,
    referralFee: calc.referralFee,
    net: calc.net,
    openerId: draft.openerId || null,
    openerRate,
    closerId: draft.closerId || null,
    closerRate,
    overrideId: draft.overrideId || null,
    overrideRate,
    commCollected: schedule ? null : 0,
    commSchedule: schedule,
    creditLine: rule.multiDraw ? draft.creditLine ?? null : null,
    drawInitialPct: rule.multiDraw ? asRate(draft.drawInitialPct ?? rule.drawInitial) : null,
    drawSubsequentPct: rule.multiDraw ? asRate(draft.drawSubsequentPct ?? rule.drawSubsequent) : null,
    dealStatus: 'Performing',
    repPaid: null,
    lenderPaid: null,
    crmId: draft.crmId?.trim() || null,
    draws: [],
  };
}

/** The F-series: one past the highest existing number. */
export function nextDealId(existingIds: Iterable<string>): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^F(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `F${max + 1}`;
}

/** Inside the clawback window after funding, or flagged by status. */
export function atRisk(deal: Pick<Deal, 'date' | 'dealStatus'>, clawbackWindowDays: number, today: string): boolean {
  if (deal.dealStatus === 'Slow Pay' || deal.dealStatus === 'Default') return true;
  const funded = new Date(`${deal.date}T00:00:00Z`).getTime();
  const now = new Date(`${today}T00:00:00Z`).getTime();
  return now - funded <= clawbackWindowDays * 86_400_000;
}

/**
 * CRM deep link from a template with `{id}`, `{opportunity}`, `{business}`
 * tokens, each URL-encoded. A blank template hides every CRM link.
 */
export function crmUrl(template: string | null | undefined, deal: Pick<Deal, 'id' | 'crmId' | 'opportunityId' | 'business'>): string {
  const tpl = (template ?? '').trim();
  if (!tpl) return '';
  return tpl
    .replace(/\{id\}/g, encodeURIComponent(deal.crmId || deal.id))
    .replace(/\{opportunity\}/g, encodeURIComponent(deal.opportunityId || deal.id))
    .replace(/\{business\}/g, encodeURIComponent(deal.business || ''));
}
