import type { ProductKind, ProductRule } from './types.js';

export class ValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('; '));
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parent products whose funding is entered as one deal-owned increment grid. */
export function productKind(ruleOrName: ProductRule | string | null | undefined): ProductKind | null {
  if (ruleOrName && typeof ruleOrName === 'object' && ruleOrName.kind) return ruleOrName.kind;
  const name = (typeof ruleOrName === 'string' ? ruleOrName : ruleOrName?.name ?? '').trim().toUpperCase();
  if (['CONSOLIDATION', 'CONSOLIDATION - UPFRONT COMM', 'REVERSE - TOTAL FUNDING'].includes(name)) return 'consolidation-upfront';
  if (['CONSOLIDATION DISBURSEMENT', 'REVERSE - DISBURSEMENT'].includes(name)) return 'consolidation-backend';
  return null;
}

export function isConsolidationParentProduct(ruleOrName: ProductRule | string | null | undefined): boolean {
  return productKind(ruleOrName) === 'consolidation-upfront';
}

/** Product-aware lender matching, including legacy consolidation aliases. */
export function lenderSupportsProduct(lender: { products?: string[] } | null | undefined, rule: ProductRule | undefined): boolean {
  if (!lender || !rule) return false;
  if (!lender.products?.length) return true;
  const kind = productKind(rule);
  return lender.products.includes(rule.name) || (!!kind && lender.products.some((name) => productKind(name) === kind));
}

export function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * This is the FUNDED board, not a pipeline. A future funded date is rejected
 * at entry rather than filtered downstream — a future-dated deal silently
 * drops out of period filters and makes lifetime and YTD totals disagree.
 */
export function assertFundedDate(date: string, today: string): void {
  if (!isIsoDate(date)) throw new ValidationError([`Funded date "${date}" is not a valid YYYY-MM-DD date`]);
  if (date > today) throw new ValidationError([`Funded date ${date} is in the future (today is ${today})`]);
}

export interface NewDealInput {
  business: string;
  fundedDate: string;
  lender: string;
  amount: number;
  product: string;
  parentId?: string | null;
  openerId?: string | null;
  closerId?: string | null;
  overrideId?: string | null;
  factor?: number | null;
  termDays?: number | null;
  creditLine?: number | null;
  commRate?: number | null;
  psfPct?: number | null;
  lineRate?: number | null;
  referralRate?: number | null;
  openerRate?: number | null;
  closerRate?: number | null;
  overrideRate?: number | null;
  originationFee?: number | null;
}

function checkedRate(v: number | null | undefined, label: string, errors: string[], required = false): number {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) {
    if (required) errors.push(`${label} is required`);
    return 0;
  }
  const n = Number(v);
  const normalized = n > 1 ? n / 100 : n;
  if (!Number.isFinite(n) || normalized < 0 || normalized > 1) errors.push(`${label} must be between 0% and 100%`);
  return normalized;
}

/** Guards that must survive: business + amount + lender, a parent when the product demands one, no future date. */
export function validateNewDeal(input: NewDealInput, rule: ProductRule | undefined, today: string): string[] {
  const errors: string[] = [];
  if (!input.business?.trim()) errors.push('Business name is required');
  if (!Number.isFinite(input.amount) || !(input.amount > 0)) errors.push(`${rule?.basis === 'draw' ? 'Draw' : 'Funding'} amount is required`);
  if (!input.lender?.trim()) errors.push('Select a lender');
  if (!rule) errors.push(`Unknown product "${input.product}"`);
  else if (rule.parent && !input.parentId) errors.push(`A ${input.product} must be attached to a parent deal`);
  else if (rule.factor && input.factor !== undefined) {
    const factor = Number(input.factor);
    if (!Number.isFinite(factor) || factor <= 1 || factor > 10) errors.push('Factor must be greater than 1 and no more than 10');
  }
  if (rule?.term && input.termDays !== undefined && (!Number.isInteger(input.termDays) || (input.termDays ?? 0) <= 0 || (input.termDays ?? 0) > 3650)) errors.push('Term must be a positive whole number of business days');
  if (rule?.multiDraw && rule.basis === 'draw' && input.creditLine !== undefined && (!Number.isFinite(input.creditLine) || (input.creditLine ?? 0) <= 0 || input.amount > (input.creditLine ?? 0))) errors.push('Credit line must be positive and initial funding cannot exceed it');
  if (input.originationFee !== undefined && (!Number.isFinite(input.originationFee) || (input.originationFee ?? 0) < 0)) errors.push('Origination fee must be finite and nonnegative');
  if (input.commRate !== undefined) checkedRate(input.commRate, 'Commission rate', errors, true);
  if (input.psfPct !== undefined) checkedRate(input.psfPct, 'PSF rate', errors);
  if (input.lineRate !== undefined) checkedRate(input.lineRate, 'Lender line rate', errors);
  if (input.referralRate !== undefined) checkedRate(input.referralRate, 'Referral rate', errors);
  // Assigned reps may omit rates so pricing can use their configured defaults.
  // Explicitly supplied rates still receive the same strict validation.
  if (input.openerRate !== undefined && input.openerRate !== null) checkedRate(input.openerRate, 'Opener rate', errors);
  if (input.closerRate !== undefined && input.closerRate !== null) checkedRate(input.closerRate, 'Closer rate', errors);
  if (input.overrideRate !== undefined && input.overrideRate !== null) checkedRate(input.overrideRate, 'Override rate', errors);
  if (!isIsoDate(input.fundedDate)) errors.push(`Funded date "${input.fundedDate}" is not a valid YYYY-MM-DD date`);
  else if (input.fundedDate > today) errors.push(`Funded date ${input.fundedDate} is in the future (today is ${today})`);
  return errors;
}
