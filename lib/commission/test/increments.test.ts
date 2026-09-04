import { describe, expect, it } from 'vitest';
import { collectedOf, collectionLabel, scheduleEvents, scheduleFor, segmentStatus, withAmounts, withStopped } from '../src/collection.js';
import { disbursementOf, parseIncrementGrid } from '../src/increments.js';
import { repLedger } from '../src/ledger.js';
import { segments, totalFunded, totalGross, totalNet } from '../src/segments.js';
import { dealLines, payableLines, repShare } from '../src/splits.js';
import { ctx, makeDeal } from './fixtures.js';

const rowan = { name: 'ROWAN', terms: 'weekly' as const, weeks: 20 };
// 500k consolidation, 20 weekly increments of 25k; 10% commission → 50k gross, 2.5k per increment.
const plan = (received: number, stoppedAfter: number | null = null) =>
  makeDeal({ id: 'F9', funded: 500_000, commRate: 0.1, referralRate: 0.1, lender: 'ROWAN', commCollected: null, commSchedule: { ...scheduleFor(rowan, '2026-06-01')!, received, stoppedAfter }, closerId: null, overrideId: null });

describe('a consolidation is funded in increments', () => {
  it('shows funding progress against the plan', () => {
    const d = plan(10);
    expect(disbursementOf(d.funded, d.commSchedule)).toEqual({ planned: 500_000, perIncrement: 25_000, disbursed: 250_000, final: 500_000, count: 10, total: 20, stopped: false, uneven: false });
    expect(totalFunded(d)).toBe(500_000); // the plan stands, so the deal is still a 500k deal
  });
  it('when the merchant opts out after 10, the deal becomes a 250k deal — funded, gross, referral, net and rep shares all scale', () => {
    const d = plan(10, 10);
    const seg = segments(d)[0]!;
    expect(seg.planned).toEqual({ amount: 500_000, gross: 50_000, referralFee: 5_000, net: 45_000, increments: 20 });
    expect(totalFunded(d)).toBe(250_000);
    expect(totalGross(d)).toBe(25_000);
    expect(seg.referralFee).toBe(2_500);
    expect(totalNet(d)).toBe(22_500);
    expect(repShare(d, 'rep-07')).toBeCloseTo(25_000 * 0.35, 2); // reps are paid on gross
    expect(repShare(plan(10), 'rep-07')).toBeCloseTo(50_000 * 0.35, 2);
    expect(disbursementOf(d.funded, d.commSchedule)).toMatchObject({ disbursed: 250_000, final: 250_000, count: 10, total: 10, stopped: true });
  });
  it('a stopped plan has only the increments that happened: fully collected, nothing still to come, no phantom units', () => {
    const d = plan(10, 10);
    const seg = segments(d)[0]!;
    expect(scheduleEvents(seg, '2026-09-01')).toHaveLength(10);
    expect(collectedOf(seg)).toBe(25_000);
    expect(segmentStatus(seg)).toBe('YES - Paid In Full');
    expect(collectionLabel(seg)).toBe('10/10 wks · opted out');
    expect(dealLines(d)).toHaveLength(10);
    expect(payableLines([d], [], 'rep-07')).toHaveLength(10);
    expect(repLedger(ctx([d]), 'rep-07')).toMatchObject({ earned: 8_750, accrued: 8_750, owed: 8_750, awaitingLender: 0 });
    // half-way through, before opting out, the other 10 increments still count as awaiting the lender
    expect(repLedger(ctx([plan(10)]), 'rep-07')).toMatchObject({ earned: 17_500, accrued: 8_750, awaitingLender: 8_750 });
  });
  it('withStopped records the opt-out at the increments received and can reopen the plan', () => {
    const seg = segments(plan(7))[0]!;
    expect(withStopped(seg, true)!.schedule!.stoppedAfter).toBe(7);
    expect(withStopped(segments(plan(7, 7))[0]!, false)!.schedule!.stoppedAfter).toBeNull();
    expect(collectionLabel(segments({ ...plan(7, 7) })[0]!)).toBe('7/7 wks · opted out');
    expect(collectionLabel(segments({ ...plan(7, 7), commSchedule: withStopped(segments(plan(7, 7))[0]!, false)!.schedule })[0]!)).toBe('7/20 wks');
  });
});

describe('the increment grid: uneven disbursements', () => {
  // 250k: 15 weeks at 12,500, then 3 at 15,000, then 2 at 8,750 = 250,000
  const grid = parseIncrementGrid('12500 x15\n15000 x3\n8750 x2');
  const uneven = (received: number, stoppedAfter: number | null = null) =>
    makeDeal({ id: 'F8', funded: 250_000, commRate: 0.1, lender: 'ROWAN', commCollected: null, commSchedule: { ...scheduleFor(rowan, '2026-06-01', { amounts: grid })!, received, stoppedAfter }, closerId: null, overrideId: null });
  it('parses pasted grids with repeats and totals them', () => {
    expect(grid).toHaveLength(20);
    expect(grid.reduce((a, b) => a + b, 0)).toBe(250_000);
    expect(parseIncrementGrid('$25,000, 25000; 10,000 x2')).toEqual([25_000, 25_000, 10_000, 10_000]);
  });
  it('the grid defines the count, and funding + commission per increment follow its proportions', () => {
    const d = uneven(0);
    expect(d.commSchedule!.weeks).toBe(20);
    const ev = scheduleEvents(segments(d)[0]!, '2026-09-01');
    expect(ev.map((e) => e.funding).slice(14, 18)).toEqual([12_500, 15_000, 15_000, 15_000]);
    // gross 25,000 → commission on a 12,500 increment is 25,000 × 12,500/250,000 = 1,250; on 15,000 it is 1,500
    expect(ev[0]!.amount).toBe(1_250);
    expect(ev[15]!.amount).toBe(1_500);
    expect(ev[19]!.amount).toBe(875);
    expect(ev.reduce((s, e) => s + e.amount, 0)).toBeCloseTo(25_000, 2);
  });
  it('received increments are scanned against the grid, not averaged', () => {
    const d = uneven(16);
    expect(disbursementOf(d.funded, d.commSchedule)).toMatchObject({ disbursed: 15 * 12_500 + 15_000, count: 16, total: 20, uneven: true, perIncrement: 15_000 });
    expect(collectedOf(segments(d)[0]!)).toBe(1_250 * 15 + 1_500);
    expect(repLedger(ctx([d]), 'rep-07').accrued).toBeCloseTo((1_250 * 15 + 1_500) * 0.35, 2);
  });
  it('opting out after 16 keeps the grid: the deal becomes what those 16 increments disbursed', () => {
    const d = uneven(16, 16);
    expect(totalFunded(d)).toBe(202_500);
    expect(totalGross(d)).toBe(20_250);
    expect(scheduleEvents(segments(d)[0]!, '2026-09-01')).toHaveLength(16);
  });
  it('withAmounts replaces the grid on a live deal and refuses one that does not total the plan or cuts received increments', () => {
    const seg = segments(uneven(5))[0]!;
    const patch = withAmounts(seg, parseIncrementGrid('10000 x25'))!;
    expect(patch.schedule!.weeks).toBe(25);
    expect(() => withAmounts(seg, [100_000, 100_000])).toThrow(/totals/);
    expect(() => withAmounts(seg, parseIncrementGrid('125000 x2'))).toThrow(/already received/);
    expect(withAmounts(seg, null)!.schedule!.amounts).toBeNull();
  });
});

describe('withCollection on an uneven grid', () => {
  it('writes dollars back to the increment count the grid implies, so reading it back agrees', async () => {
    const { withCollection, collectedOf } = await import('../src/collection.js');
    // 4 increments disbursing 40/30/20/10 of a 100k plan; commission 10k spread the same way.
    const seg = { gross: 10_000, collected: null, schedule: { mode: 'weekly' as const, weeks: 4, received: 0, startDate: '2026-08-01', amounts: [40_000, 30_000, 20_000, 10_000] } };
    const p = withCollection(seg, 7_000);
    expect(p.schedule!.received).toBe(2); // 4,000 + 3,000
    expect(collectedOf({ ...seg, ...p })).toBe(7_000);
    expect(withCollection(seg, 8_999).schedule!.received).toBe(2);
    expect(withCollection(seg, 9_000).schedule!.received).toBe(3);
    expect(withCollection(seg, 10_000).schedule!.received).toBe(4);
  });
});
