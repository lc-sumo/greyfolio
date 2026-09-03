import { describe, expect, it } from 'vitest';
import { outstandingGross } from '../src/collection.js';
import { newDraw } from '../src/draws.js';
import { repLedger } from '../src/ledger.js';
import { ctx, makeDeal } from './fixtures.js';

describe('newDraw', () => {
  const loc = makeDeal({ id: 'F12', product: 'LOC - INITIAL', funded: 40_000, commRate: 0.08, drawSubsequentPct: 0.04, commCollected: 3_200 });

  it('prices at the subsequent draw rate and appends the next segment', () => {
    const d = newDraw(loc, { amount: 25_000, date: '2026-09-01' });
    expect(d).toMatchObject({ n: 1, ref: 'D1', amount: 25_000, commRate: 0.04, gross: 1_000, referralFee: 0, net: 1_000, collected: 0, schedule: null });
    const d2 = newDraw({ ...loc, draws: [d] }, { amount: 18_000, date: '2026-09-02' });
    expect(d2).toMatchObject({ n: 2, ref: 'D2', gross: 720 });
  });

  it('immediately increases outstanding commission and the reps\' earned', () => {
    expect(outstandingGross(loc)).toBe(0);
    const before = repLedger(ctx([loc]), 'rep-07').earned;
    const after = { ...loc, draws: [newDraw(loc, { amount: 25_000, date: '2026-09-01' })] };
    expect(outstandingGross(after)).toBe(1_000);
    expect(repLedger(ctx([after]), 'rep-07').earned).toBe(before + 350);
  });

  it('applies the partner referral rate and cap to the draw', () => {
    const d = newDraw(loc, { amount: 25_000, date: '2026-09-01', partner: { name: 'MBC', pct: 0.15, monthlyCap: 15_000 } });
    expect(d.referralFee).toBe(150);
    expect(d.net).toBe(850);
  });

  it('carries a weekly schedule when the caller supplies one', () => {
    const d = newDraw(loc, { amount: 10_000, date: '2026-09-01', schedule: { mode: 'weekly', weeks: 12, received: 0, startDate: '2026-09-08' } });
    expect(d.collected).toBeNull();
    expect(d.schedule?.weeks).toBe(12);
  });

  it('rejects a missing amount or rate', () => {
    expect(() => newDraw(loc, { amount: 0, date: '2026-09-01' })).toThrow(/draw amount/);
    expect(() => newDraw(makeDeal({ id: 'F1' }), { amount: 100, date: '2026-09-01' })).toThrow(/subsequent draw rate/);
  });
});
