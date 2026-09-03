import { describe, expect, it } from 'vitest';
import { ValidationError, assertFundedDate, validateNewDeal } from '../src/validate.js';
import type { ProductRule } from '../src/types.js';
import { TODAY } from './fixtures.js';

const mca: ProductRule = { name: 'MCA', basis: 'funded', factor: true, term: true, parent: false, comm: 0.12, clawback: true, renewal: true, multiDraw: false, drawInitial: null, drawSubsequent: null };
const draw: ProductRule = { ...mca, name: 'LOC DRAW', basis: 'draw', factor: false, parent: true };

describe('assertFundedDate — invariant #8: never a funded date in the future', () => {
  it('accepts today and the past', () => {
    expect(() => assertFundedDate(TODAY, TODAY)).not.toThrow();
    expect(() => assertFundedDate('2026-01-01', TODAY)).not.toThrow();
  });
  it('rejects tomorrow at entry', () => {
    expect(() => assertFundedDate('2026-09-03', TODAY)).toThrow(ValidationError);
    expect(() => assertFundedDate('2027-01-01', TODAY)).toThrow(/in the future/);
  });
  it('rejects malformed dates', () => {
    expect(() => assertFundedDate('2026-02-30', TODAY)).toThrow(/not a valid/);
    expect(() => assertFundedDate('09/02/2026', TODAY)).toThrow(/not a valid/);
  });
});

describe('validateNewDeal', () => {
  const ok = { business: 'Northstar Dental', fundedDate: TODAY, lender: 'MBC', amount: 50_000, product: 'MCA' };
  it('passes a complete deal', () => {
    expect(validateNewDeal(ok, mca, TODAY)).toEqual([]);
  });
  it('requires business, amount and lender', () => {
    expect(validateNewDeal({ ...ok, business: ' ', amount: 0, lender: '' }, mca, TODAY)).toEqual([
      'Business name is required',
      'Funding amount is required',
      'Select a lender',
    ]);
  });
  it('requires a parent when the product demands one', () => {
    expect(validateNewDeal({ ...ok, product: 'LOC DRAW' }, draw, TODAY)).toEqual(['A LOC DRAW must be attached to a parent deal']);
    expect(validateNewDeal({ ...ok, product: 'LOC DRAW', parentId: 'F3' }, draw, TODAY)).toEqual([]);
  });
  it('rejects a future funded date', () => {
    expect(validateNewDeal({ ...ok, fundedDate: '2026-09-03' }, mca, TODAY)).toEqual([`Funded date 2026-09-03 is in the future (today is ${TODAY})`]);
  });
  it('rejects an unknown product', () => {
    expect(validateNewDeal({ ...ok, product: 'WIDGET' }, undefined, TODAY)).toEqual(['Unknown product "WIDGET"']);
  });
});
