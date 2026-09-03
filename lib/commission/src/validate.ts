import type { ProductRule } from './types.js';

export class ValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('; '));
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
}

/** Guards that must survive: business + amount + lender, a parent when the product demands one, no future date. */
export function validateNewDeal(input: NewDealInput, rule: ProductRule | undefined, today: string): string[] {
  const errors: string[] = [];
  if (!input.business?.trim()) errors.push('Business name is required');
  if (!(input.amount > 0)) errors.push(`${rule?.basis === 'draw' ? 'Draw' : 'Funding'} amount is required`);
  if (!input.lender?.trim()) errors.push('Select a lender');
  if (!rule) errors.push(`Unknown product "${input.product}"`);
  else if (rule.parent && !input.parentId) errors.push(`A ${input.product} must be attached to a parent deal`);
  if (!isIsoDate(input.fundedDate)) errors.push(`Funded date "${input.fundedDate}" is not a valid YYYY-MM-DD date`);
  else if (input.fundedDate > today) errors.push(`Funded date ${input.fundedDate} is in the future (today is ${today})`);
  return errors;
}
