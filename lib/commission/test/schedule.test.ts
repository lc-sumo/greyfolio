import { describe, expect, it } from 'vitest';
import { collectedOf, collectionLabel, expectedBetween, recordWeek, scheduleEvents, scheduleFor, segmentStatus, withCollection, withRemainder, withStatus, withUpfront } from '../src/collection.js';
import type { WeeklySchedule } from '../src/types.js';

const seg = (schedule: WeeklySchedule, gross = 10_000) => ({ gross, collected: null, schedule, date: '2026-06-01' });
const rowan = { name: 'ROWAN', terms: 'weekly' as const, weeks: 20 };

describe('payout structures', () => {
  it('plain weekly lender: equal increments, one cadence after funding', () => {
    const s = scheduleFor(rowan, '2026-06-01')!;
    expect(s).toMatchObject({ weeks: 20, received: 0, startDate: '2026-06-08', cadenceDays: 7, remainder: 'spread' });
    expect(s.upfrontPct).toBeUndefined();
    expect(collectedOf(seg({ ...s, received: 5 }))).toBe(2_500);
  });
  it('50 upfront, 50 spread across 10 increments', () => {
    const s = scheduleFor(rowan, '2026-06-01', { increments: 10, upfrontPct: 50 })!;
    expect(s).toMatchObject({ weeks: 10, upfrontPct: 0.5, upfrontReceived: false, remainder: 'spread' });
    expect(collectedOf(seg(s))).toBe(0);
    expect(collectedOf(seg({ ...s, upfrontReceived: true }))).toBe(5_000);
    expect(collectedOf(seg({ ...s, upfrontReceived: true, received: 4 }))).toBe(7_000);
    expect(collectionLabel(seg({ ...s, upfrontReceived: true, received: 4 }))).toBe('50% up + 4/10 wks');
    expect(collectionLabel(seg({ ...s, received: 4 }))).toBe('(no) 50% up + 4/10 wks');
    expect(collectedOf(seg({ ...s, upfrontReceived: true, received: 10 }))).toBe(10_000);
    expect(collectionLabel(seg({ ...s, upfrontReceived: true, received: 10 }))).toBe('10/10 wks');
  });
  it('50 upfront, 50 when increments are done', () => {
    const s = scheduleFor(rowan, '2026-06-01', { increments: 8, upfrontPct: 0.5, remainder: 'at-end', cadenceDays: 14 })!;
    expect(s).toMatchObject({ weeks: 8, upfrontPct: 0.5, remainder: 'at-end', remainderReceived: false, cadenceDays: 14, startDate: '2026-06-15' });
    // increments only track progress; money arrives upfront and at the end
    expect(collectedOf(seg({ ...s, upfrontReceived: true, received: 8 }))).toBe(5_000);
    expect(collectionLabel(seg({ ...s, upfrontReceived: true, received: 8 }))).toBe('50% up + 8/8 incr. · final due');
    expect(segmentStatus(seg({ ...s, upfrontReceived: true, received: 8 }))).toBe('Partially Paid');
    expect(collectedOf(seg({ ...s, upfrontReceived: true, received: 8, remainderReceived: true }))).toBe(10_000);
    expect(segmentStatus(seg({ ...s, upfrontReceived: true, received: 8, remainderReceived: true }))).toBe('YES - Paid In Full');
  });
  it('any lender can carry increments when the deal asks for them', () => {
    expect(scheduleFor({ name: 'MBC', terms: 'upfront', weeks: 0 }, '2026-06-01')).toBeNull();
    expect(scheduleFor({ name: 'MBC', terms: 'upfront', weeks: 0 }, '2026-06-01', { increments: 4 })).toMatchObject({ weeks: 4 });
  });
  it('lender defaults apply and the deal can override them', () => {
    const lender = { ...rowan, upfrontPct: 0.5, remainder: 'at-end' as const };
    expect(scheduleFor(lender, '2026-06-01')).toMatchObject({ upfrontPct: 0.5, remainder: 'at-end', weeks: 20 });
    expect(scheduleFor(lender, '2026-06-01', { upfrontPct: 0, remainder: 'spread', increments: 6 })).toMatchObject({ remainder: 'spread', weeks: 6 });
  });
});

describe('the single collection writer with structures', () => {
  const s = scheduleFor(rowan, '2026-06-01', { increments: 10, upfrontPct: 0.5 })!;
  it('dollars map onto upfront then increments', () => {
    expect(withCollection(seg(s), 5_000).schedule).toMatchObject({ upfrontReceived: true, received: 0 });
    expect(withCollection(seg(s), 7_000).schedule).toMatchObject({ upfrontReceived: true, received: 4 });
    expect(withCollection(seg(s), 2_000).schedule).toMatchObject({ upfrontReceived: false, received: 4 }); // partial without the upfront
    expect(collectedOf(seg(withCollection(seg(s), 7_000).schedule!))).toBe(7_000);
  });
  it('Paid In Full lands everything; Waiting clears everything', () => {
    const full = withStatus(seg(s), 'YES - Paid In Full').schedule!;
    expect(full).toMatchObject({ upfrontReceived: true, received: 10 });
    expect(collectedOf(seg(full))).toBe(10_000);
    expect(withStatus(seg(full), 'Waiting for payment').schedule).toMatchObject({ upfrontReceived: false, received: 0 });
    const atEnd = scheduleFor(rowan, '2026-06-01', { increments: 8, upfrontPct: 0.5, remainder: 'at-end' })!;
    expect(withStatus(seg(atEnd), 'YES - Paid In Full').schedule).toMatchObject({ upfrontReceived: true, remainderReceived: true, received: 8 });
  });
  it('upfront and remainder have their own recorders; recordWeek never auto-pays the remainder', () => {
    const atEnd = scheduleFor(rowan, '2026-06-01', { increments: 2, upfrontPct: 0.5, remainder: 'at-end' })!;
    expect(withUpfront(seg(atEnd), true)!.schedule).toMatchObject({ upfrontReceived: true });
    let cur = { ...atEnd, ...withUpfront(seg(atEnd), true)!.schedule! };
    cur = { ...cur, ...recordWeek(seg(cur), 1)!.schedule! };
    cur = { ...cur, ...recordWeek(seg(cur), 1)!.schedule! };
    expect(cur.received).toBe(2);
    expect(collectedOf(seg(cur))).toBe(5_000);
    cur = { ...cur, ...withRemainder(seg(cur), true)!.schedule! };
    expect(collectedOf(seg(cur))).toBe(10_000);
    expect(withUpfront(seg(scheduleFor(rowan, '2026-06-01')!), true)).toBeNull();
    expect(withRemainder(seg(s), true)).toBeNull();
  });
});

describe('expected receipts', () => {
  it('lists upfront, each increment on its cadence, and the final, with overdue flags', () => {
    const s = scheduleFor(rowan, '2026-06-01', { increments: 3, upfrontPct: 0.4, remainder: 'at-end', cadenceDays: 7 })!;
    const ev = scheduleEvents(seg({ ...s, upfrontReceived: true, received: 1 }), '2026-06-20');
    expect(ev.map((e) => [e.kind, e.expected, e.amount, e.received, e.overdue])).toEqual([
      ['upfront', '2026-06-01', 4_000, true, false],
      ['increment', '2026-06-08', 0, true, false],
      ['increment', '2026-06-15', 0, false, true],
      ['increment', '2026-06-22', 0, false, false],
      ['remainder', '2026-06-29', 6_000, false, false],
    ]);
  });
  it('spread increments carry money and roll into expected-between', () => {
    const s = scheduleFor(rowan, '2026-06-01', { increments: 4 })!; // 2,500 each on Jun 8/15/22/29
    const cur = seg({ ...s, received: 1 });
    expect(expectedBetween([cur], '2026-06-10', '2026-06-25', '2026-06-20')).toEqual({ amount: 5_000, count: 2, overdue: 2_500 });
    expect(expectedBetween([seg({ ...s, received: 4 })], '2026-06-01', '2026-12-31', '2026-06-20')).toEqual({ amount: 0, count: 0, overdue: 0 });
  });
});
