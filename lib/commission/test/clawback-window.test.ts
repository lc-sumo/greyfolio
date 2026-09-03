import { describe, expect, it } from 'vitest';
import { businessDaysPerPayment, clawbackWindow } from '../src/clawback-window.js';
import type { Lender, ProductRule } from '../src/types.js';

const deal = { date: '2026-06-01', frequency: 'Daily', dealStatus: 'Performing' };
const mca: ProductRule = { name: 'MCA', basis: 'funded', factor: true, term: true, parent: false, comm: 0.12, clawback: true, renewal: true, multiDraw: false, drawInitial: null, drawSubsequent: null };

describe('clawbackWindow', () => {
  it('falls back to the global window when the lender has no policy', () => {
    const w = clawbackWindow(deal, { defaultDays: 30 }, '2026-06-15');
    expect(w).toMatchObject({ basis: 'days', count: 30, source: 'default', clearsOn: '2026-07-01', cleared: false, daysLeft: 16 });
    expect(clawbackWindow(deal, { defaultDays: 30 }, '2026-07-01')).toMatchObject({ cleared: true, daysLeft: 0, label: 'Cleared clawback · 30 days' });
  });
  it('a lender policy in days overrides the default', () => {
    const lender: Lender = { name: 'UFS', terms: 'upfront', weeks: 0, clawback: { basis: 'days', count: 60 } };
    expect(clawbackWindow(deal, { lender, defaultDays: 30 }, '2026-07-01')).toMatchObject({ source: 'lender', count: 60, clearsOn: '2026-07-31', cleared: false, daysLeft: 30 });
  });
  it('a payments policy counts merchant payments at the deal frequency (business days)', () => {
    const lender: Lender = { name: 'ROWAN', terms: 'weekly', weeks: 20, clawback: { basis: 'payments', count: 10 } };
    // 10 daily payments = 10 business days from Mon Jun 1 → Mon Jun 15
    expect(clawbackWindow(deal, { lender, defaultDays: 30 }, '2026-06-10')).toMatchObject({ basis: 'payments', clearsOn: '2026-06-15', cleared: false });
    // 10 weekly payments = 50 business days
    expect(clawbackWindow({ ...deal, frequency: 'Weekly' }, { lender, defaultDays: 30 }, '2026-06-10').clearsOn).toBe('2026-08-10');
    expect(businessDaysPerPayment('Daily')).toBe(1);
    expect(businessDaysPerPayment('Weekly')).toBe(5);
    expect(businessDaysPerPayment('Bi-Weekly')).toBe(10);
    expect(businessDaysPerPayment('Monthly')).toBe(21);
  });
  it('a lender with no clawback, or an exempt product, has nothing to clear', () => {
    const lender: Lender = { name: 'WALL', terms: 'upfront', weeks: 0, clawback: { basis: 'none', count: 0 } };
    expect(clawbackWindow(deal, { lender, defaultDays: 30 }, '2026-06-02')).toMatchObject({ basis: 'none', cleared: true, clearsOn: null, source: 'lender' });
    expect(clawbackWindow(deal, { lender: { name: 'MBC', terms: 'upfront', weeks: 0, clawback: { basis: 'days', count: 30 } }, rule: { ...mca, clawback: false }, defaultDays: 30 }, '2026-06-02')).toMatchObject({ basis: 'none', source: 'product', cleared: true });
  });
  it('flags a default or slow pay inside the window', () => {
    expect(clawbackWindow({ ...deal, dealStatus: 'Default' }, { defaultDays: 30 }, '2026-06-10').label).toBe('Default inside the 30 days window');
  });
});
