import { describe, expect, it } from 'vitest';
import { collectedOf, collectionLabel, scheduleEvents, scheduleFor, segmentStatus, withStopped } from '../src/collection.js';
import { disbursementOf } from '../src/increments.js';
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
    expect(disbursementOf(d.funded, d.commSchedule)).toEqual({ planned: 500_000, perIncrement: 25_000, disbursed: 250_000, final: 500_000, count: 10, total: 20, stopped: false });
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
    expect(repShare(d, 'rep-07')).toBeCloseTo(22_500 * 0.35, 2);
    expect(repShare(plan(10), 'rep-07')).toBeCloseTo(45_000 * 0.35, 2);
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
    expect(repLedger(ctx([d]), 'rep-07')).toMatchObject({ earned: 7_875, accrued: 7_875, owed: 7_875, awaitingLender: 0 });
    // half-way through, before opting out, the other 10 increments still count as awaiting the lender
    expect(repLedger(ctx([plan(10)]), 'rep-07')).toMatchObject({ earned: 15_750, accrued: 7_875, awaitingLender: 7_875 });
  });
  it('withStopped records the opt-out at the increments received and can reopen the plan', () => {
    const seg = segments(plan(7))[0]!;
    expect(withStopped(seg, true)!.schedule!.stoppedAfter).toBe(7);
    expect(withStopped(segments(plan(7, 7))[0]!, false)!.schedule!.stoppedAfter).toBeNull();
    expect(collectionLabel(segments({ ...plan(7, 7) })[0]!)).toBe('7/7 wks · opted out');
    expect(collectionLabel(segments({ ...plan(7, 7), commSchedule: withStopped(segments(plan(7, 7))[0]!, false)!.schedule })[0]!)).toBe('7/20 wks');
  });
});
