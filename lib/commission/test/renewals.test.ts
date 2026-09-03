import { describe, expect, it } from 'vitest';
import { addBusinessDays, addMonths, businessDaysBetween, effectiveDealStatus, renewalOf } from '../src/renewals.js';
import { makeDeal } from './fixtures.js';

describe('business-day calendar', () => {
  it('WORKDAY skips weekends', () => {
    expect(addBusinessDays('2026-09-04', 1)).toBe('2026-09-07'); // Fri → Mon
    expect(addBusinessDays('2026-09-01', 5)).toBe('2026-09-08');
    expect(addBusinessDays('2026-09-01', 0)).toBe('2026-09-01');
    expect(addBusinessDays('2026-01-05', 120)).toBe('2026-06-22');
  });
  it('counts business days between dates', () => {
    expect(businessDaysBetween('2026-09-04', '2026-09-07')).toBe(1);
    expect(businessDaysBetween('2026-09-01', '2026-09-08')).toBe(5);
    expect(businessDaysBetween('2026-09-08', '2026-09-01')).toBe(0);
    expect(businessDaysBetween('2026-01-05', addBusinessDays('2026-01-05', 120))).toBe(120);
  });
  it('EDATE clamps to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });
});

describe('renewalOf', () => {
  const settings = { renewalMark: 0.4 };
  it('marks the deal at 40% of the term in business days and buckets it', () => {
    const d = makeDeal({ id: 'F1', date: '2026-06-01', termDays: 100, funded: 100_000, commRate: 0.1 });
    const r = renewalOf(d, settings, '2026-07-01');
    expect(r.markDate).toBe(addBusinessDays('2026-06-01', 40));
    expect(r.maturityDate).toBe(addBusinessDays('2026-06-01', 100));
    expect(r.pctPaidIn).toBe(0.22); // 22 business days of 100
    expect(r.bucket).toBe('prospecting'); // 30 days funded: eligible for more capital, mark still 26 days out
    expect(r.daysToMark).toBe(26);
    expect(r.soon).toBe(false);
    expect(r.prospectingDate).toBe('2026-07-01');
    expect(r.effectiveStatus).toBe('Prospecting');
    expect(r.estRenewalGross).toBe(10_000);
  });
  it('is due once the mark is reached, building far before it, soon inside 21 days', () => {
    const d = makeDeal({ id: 'F1', date: '2026-06-01', termDays: 100 });
    expect(renewalOf(d, settings, '2026-08-01')).toMatchObject({ bucket: 'due', effectiveStatus: 'Refi Ready', soon: false });
    expect(renewalOf(d, settings, '2026-06-02')).toMatchObject({ bucket: 'building', effectiveStatus: 'Performing', daysToProspecting: 29, soon: false });
    expect(renewalOf(d, settings, '2026-07-10')).toMatchObject({ bucket: 'prospecting', soon: true, daysToMark: 17 });
  });
  it('the Prospecting trigger fires additionalCapitalAfterDays after funding, calendar days', () => {
    const d = makeDeal({ id: 'F1', date: '2026-06-01', termDays: 300 });
    expect(renewalOf(d, settings, '2026-06-30')).toMatchObject({ bucket: 'building', effectiveStatus: 'Performing', daysToProspecting: 1 });
    expect(renewalOf(d, settings, '2026-07-01')).toMatchObject({ bucket: 'prospecting', effectiveStatus: 'Prospecting', daysToProspecting: 0 });
    expect(renewalOf(d, { renewalMark: 0.4, additionalCapitalAfterDays: 45 }, '2026-07-01').bucket).toBe('building');
    // a stored Performing / Prospecting / Refi Ready never blocks the derivation
    expect(effectiveDealStatus({ ...d, dealStatus: 'Refi Ready' }, settings, '2026-06-02')).toBe('Performing');
    expect(effectiveDealStatus({ ...d, dealStatus: 'Performing' }, settings, '2026-07-15')).toBe('Prospecting');
  });
  it('status overrides the math', () => {
    const d = makeDeal({ id: 'F1', date: '2026-01-01', termDays: 100 });
    expect(renewalOf({ ...d, dealStatus: 'Refinanced' }, settings, '2026-09-01').bucket).toBe('refinanced');
    expect(renewalOf({ ...d, dealStatus: 'Paid In Full' }, settings, '2026-09-01').bucket).toBe('refinanced');
    expect(renewalOf({ ...d, dealStatus: 'Slow Pay' }, settings, '2026-09-01').bucket).toBe('risk');
    expect(renewalOf({ ...d, dealStatus: 'Default' }, settings, '2026-09-01').bucket).toBe('risk');
    expect(effectiveDealStatus({ ...d, dealStatus: 'Slow Pay' }, settings, '2026-09-01')).toBe('Slow Pay');
  });
  it('monthly deals count the term in months', () => {
    const d = { ...makeDeal({ id: 'F1', date: '2026-01-15', termDays: 10 }), frequency: 'Monthly' };
    const r = renewalOf(d, settings, '2026-06-15');
    expect(r.markDate).toBe('2026-05-15');
    expect(r.maturityDate).toBe('2026-11-15');
    expect(r.pctPaidIn).toBe(0.5);
    expect(r.bucket).toBe('due');
  });
  it('a deal without a term never becomes due and has no dates', () => {
    const r = renewalOf({ ...makeDeal({ id: 'F1' }), termDays: null }, settings, '2026-09-01');
    expect(r).toMatchObject({ markDate: null, maturityDate: null, daysToMark: null, pctPaidIn: 0 });
    expect(r.bucket).toBe('prospecting'); // no term → never due, but still eligible for more capital after 30 days
  });
  it('paid-in caps at 100% after maturity', () => {
    expect(renewalOf(makeDeal({ id: 'F1', date: '2025-01-01', termDays: 50 }), settings, '2026-09-01').pctPaidIn).toBe(1);
  });
});
