import { describe, expect, it } from 'vitest';
import { collectedOf, segments } from '../src/index.js';
import { atRisk, crmUrl, nextDealId, priceDeal, type PricingContext } from '../src/deal.js';
import type { ProductRule } from '../src/types.js';
import { ValidationError } from '../src/validate.js';

const MCA: ProductRule = { name: 'MCA', basis: 'funded', factor: true, term: true, parent: false, comm: 0.12, clawback: true, renewal: true, multiDraw: false, drawInitial: null, drawSubsequent: null };
const LOC: ProductRule = { name: 'LOC - INITIAL', basis: 'funded', factor: false, term: true, parent: false, comm: 0.08, clawback: true, renewal: false, multiDraw: true, drawInitial: 0.08, drawSubsequent: 0.04 };
const TERM: ProductRule = { name: 'TERM LOAN', basis: 'funded', factor: false, term: true, parent: false, comm: 0.05, clawback: false, renewal: true, multiDraw: false, drawInitial: null, drawSubsequent: null };
const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({ id: 'F10', today: '2026-09-02', rule: MCA, lender: { name: 'MBC', terms: 'upfront', weeks: 0 }, partner: undefined, ...over });
const draft = { business: 'Northstar Dental', fundedDate: '2026-09-01', lender: 'MBC', product: 'MCA', amount: 100_000, termDays: 120, factor: 1.3, commRate: 12, psfPct: 2, originationFee: 500, openerId: 'rep-a', openerRate: 20, closerId: 'rep-b', closerRate: 20, overrideId: 'rep-c', overrideRate: 5 };

describe('priceDeal', () => {
  it('prices an MCA from the form, accepting percent-style rates', () => {
    const d = priceDeal(draft, ctx());
    expect(d).toMatchObject({ id: 'F10', opportunityId: 'F10', funded: 100_000, factor: 1.3, apr: null, termDays: 120, payback: 130_000, commRate: 0.12, psfPct: 0.02, originationFee: 500, gross: 14_500, referralFee: 0, net: 14_500, openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, commCollected: 0, commSchedule: null, dealStatus: 'Performing' });
    expect(segments(d)).toHaveLength(1);
  });
  it('attaches a weekly schedule for weekly lenders and starts uncollected', () => {
    const d = priceDeal({ ...draft, lender: 'ROWAN' }, ctx({ lender: { name: 'ROWAN', terms: 'weekly', weeks: 20 } }));
    expect(d.commSchedule).toMatchObject({ mode: 'weekly', weeks: 20, received: 0, startDate: '2026-09-08', cadenceDays: 7, remainder: 'spread' });
    expect(d.commCollected).toBeNull();
    expect(collectedOf(segments(d)[0]!)).toBe(0);
  });
  it('a consolidation can ask for 50 upfront and the rest when the increments are done', () => {
    const d = priceDeal({ ...draft, lender: 'MBC', commIncrements: 12, commUpfrontPct: 50, commRemainder: 'at-end', commCadenceDays: 7 }, ctx());
    expect(d.commSchedule).toMatchObject({ weeks: 12, upfrontPct: 0.5, upfrontReceived: false, remainder: 'at-end', remainderReceived: false, cadenceDays: 7, startDate: '2026-09-08' });
    expect(collectedOf(segments(d)[0]!)).toBe(0);
  });
  it('applies the partner rate and cap', () => {
    const d = priceDeal({ ...draft, referralPartner: 'MBC', referralRate: undefined }, ctx({ partner: { name: 'MBC', pct: 0.15, monthlyCap: 15_000 } }));
    expect(d.referralPartner).toBe('MBC');
    expect(d.referralFee).toBe(2_175);
    expect(d.net).toBe(12_325);
  });
  it('multi-draw products take the initial draw rate and carry draw settings', () => {
    const d = priceDeal({ ...draft, product: 'LOC - INITIAL', commRate: undefined, factor: undefined, creditLine: 250_000 }, ctx({ rule: LOC }));
    expect(d).toMatchObject({ commRate: 0.08, gross: 8_000 + 2_000 + 500, creditLine: 250_000, drawInitialPct: 0.08, drawSubsequentPct: 0.04, factor: null });
  });
  it('amortizing products use APR × term / 252 for payback', () => {
    const d = priceDeal({ ...draft, product: 'TERM LOAN', factor: undefined, apr: 12.6, termDays: 252, commRate: 5 }, ctx({ rule: TERM }));
    expect(d).toMatchObject({ factor: null, apr: 12.6, payback: 112_600, gross: 5_000 + 2_000 + 500 });
  });
  it('an unassigned role earns nothing even if a rate was typed', () => {
    const d = priceDeal({ ...draft, overrideId: null, overrideRate: 5 }, ctx());
    expect(d.overrideId).toBeNull();
    expect(d.overrideRate).toBe(0);
  });
  it('rejects the guards with every error listed', () => {
    expect(() => priceDeal({ ...draft, business: '', amount: 0, lender: '' }, ctx({ lender: undefined }))).toThrow(ValidationError);
    try {
      priceDeal({ ...draft, fundedDate: '2026-09-03' }, ctx());
    } catch (e) {
      expect((e as ValidationError).errors).toEqual(['Funded date 2026-09-03 is in the future (today is 2026-09-02)']);
    }
    expect(() => priceDeal({ ...draft, product: 'LOC DRAW' }, ctx({ rule: { ...LOC, name: 'LOC DRAW', basis: 'draw', parent: true } }))).toThrow(/parent deal/);
    expect(() => priceDeal({ ...draft, lender: 'NOPE' }, ctx({ lender: undefined }))).toThrow(/Unknown lender/);
  });
});

describe('nextDealId', () => {
  it('is one past the highest F-number, ignoring other ids', () => {
    expect(nextDealId([])).toBe('F1');
    expect(nextDealId(['F1', 'F12', 'F3', 'X9'])).toBe('F13');
  });
});

describe('atRisk', () => {
  it('flags deals inside the clawback window or in a bad status', () => {
    expect(atRisk({ date: '2026-08-20', dealStatus: 'Performing' }, 30, '2026-09-02')).toBe(true);
    expect(atRisk({ date: '2026-07-01', dealStatus: 'Performing' }, 30, '2026-09-02')).toBe(false);
    expect(atRisk({ date: '2026-01-01', dealStatus: 'Slow Pay' }, 30, '2026-09-02')).toBe(true);
  });
});

describe('crmUrl', () => {
  const deal = { id: 'F12', crmId: null, opportunityId: 'F3', business: 'Cedar & Stone HVAC' };
  it('substitutes and URL-encodes every token', () => {
    expect(crmUrl('https://crm.test/o/{opportunity}/d/{id}?q={business}', deal)).toBe('https://crm.test/o/F3/d/F12?q=Cedar%20%26%20Stone%20HVAC');
    expect(crmUrl('https://crm.test/{id}', { ...deal, crmId: 'abc 1' })).toBe('https://crm.test/abc%201');
  });
  it('is blank when the template is blank', () => {
    expect(crmUrl('', deal)).toBe('');
    expect(crmUrl(null, deal)).toBe('');
  });
});
