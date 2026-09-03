import { describe, expect, it } from 'vitest';
import {
  collectedOf,
  collectionLabel,
  dealCommissionStatus,
  outstandingOf,
  recordWeek,
  scheduleFor,
  segmentStatus,
  statusFor,
  withCollection,
  withStatus,
} from '../src/collection.js';
import { segments } from '../src/segments.js';
import { makeDeal } from './fixtures.js';

describe('statusFor is a pure function of collection', () => {
  it('maps collected dollars to the three statuses', () => {
    expect(statusFor(0, 1000)).toBe('Waiting for payment');
    expect(statusFor(1, 1000)).toBe('Partially Paid');
    expect(statusFor(999.99, 1000)).toBe('Partially Paid');
    expect(statusFor(1000, 1000)).toBe('YES - Paid In Full');
    expect(statusFor(1200, 1000)).toBe('YES - Paid In Full');
  });
  it('a zero-gross segment is never "paid in full"', () => {
    expect(statusFor(0, 0)).toBe('Waiting for payment');
  });
  it('is deterministic — same inputs, same output, no other state', () => {
    for (const [c, g] of [[0, 10], [5, 10], [10, 10]] as const) {
      expect(statusFor(c, g)).toBe(statusFor(c, g));
    }
  });
});

describe('collectedOf / outstandingOf', () => {
  it('a weekly segment derives dollars from weeks received', () => {
    const seg = { gross: 3_880, collected: null, schedule: { mode: 'weekly' as const, weeks: 20, received: 14, startDate: null } };
    expect(collectedOf(seg)).toBe(2_716);
    expect(outstandingOf(seg)).toBe(1_164);
    expect(collectionLabel(seg)).toBe('14/20 wks');
    expect(segmentStatus(seg)).toBe('Partially Paid');
  });
  it('an upfront segment stores collected dollars explicitly, clamped to gross', () => {
    expect(collectedOf({ gross: 1000, collected: 400, schedule: null })).toBe(400);
    expect(collectedOf({ gross: 1000, collected: 5000, schedule: null })).toBe(1000);
    expect(collectedOf({ gross: 1000, collected: -5, schedule: null })).toBe(0);
    expect(collectedOf({ gross: 1000, collected: null, schedule: null })).toBe(0);
  });
  it('a partially collected upfront deal reports PARTIAL, not full, collection', () => {
    const seg = { gross: 1_000, collected: 500, schedule: null };
    expect(segmentStatus(seg)).toBe('Partially Paid');
    expect(collectionLabel(seg)).toBe('Part collected');
    expect(outstandingOf(seg)).toBe(500);
  });
  it('the deal headline status is derived from its segments, not stored', () => {
    const d = makeDeal({ id: 'F1', funded: 10_000, commRate: 0.1, commCollected: 1_000 });
    expect(dealCommissionStatus(d)).toBe('YES - Paid In Full');
    const half = makeDeal({ id: 'F2', funded: 10_000, commRate: 0.1, commCollected: 250 });
    expect(dealCommissionStatus(half)).toBe('Partially Paid');
  });
});

describe('the status dropdown writes collection', () => {
  it('Paid In Full on a weekly segment sets received = weeks', () => {
    const seg = { gross: 3_880, collected: null, schedule: { mode: 'weekly' as const, weeks: 20, received: 14, startDate: null } };
    const patch = withStatus(seg, 'YES - Paid In Full');
    expect(patch.schedule?.received).toBe(20);
    expect(patch.collected).toBeNull();
    const after = { ...seg, ...patch };
    expect(collectedOf(after)).toBe(3_880);
    expect(segmentStatus(after)).toBe('YES - Paid In Full');
    expect(outstandingOf(after)).toBe(0);
  });
  it('a manual Paid In Full cannot coexist with "70% collected" — the next recorded week is a no-op', () => {
    const seg = { gross: 2_000, collected: null, schedule: { mode: 'weekly' as const, weeks: 10, received: 7, startDate: null } };
    const paid = { ...seg, ...withStatus(seg, 'YES - Paid In Full') };
    const next = { ...paid, ...recordWeek(paid, 1) };
    expect(next.schedule?.received).toBe(10);
    expect(segmentStatus(next)).toBe('YES - Paid In Full');
  });
  it('Waiting for payment zeroes collection', () => {
    const seg = { gross: 1000, collected: 1000, schedule: null };
    expect(withStatus(seg, 'Waiting for payment')).toEqual({ collected: 0, schedule: null });
  });
  it('Partially Paid keeps an existing partial figure or takes an explicit one', () => {
    expect(withStatus({ gross: 1000, collected: 300, schedule: null }, 'Partially Paid').collected).toBe(300);
    expect(withStatus({ gross: 1000, collected: 0, schedule: null }, 'Partially Paid', 650).collected).toBe(650);
    expect(withStatus({ gross: 1000, collected: 1000, schedule: null }, 'Partially Paid').collected).toBe(500);
  });
});

describe('withCollection / recordWeek', () => {
  it('rounds dollars to whole weeks on a scheduled segment', () => {
    const seg = { gross: 2_000, collected: null, schedule: { mode: 'weekly' as const, weeks: 10, received: 0, startDate: null } };
    expect(withCollection(seg, 1_000).schedule?.received).toBe(5);
    expect(withCollection(seg, 1_050).schedule?.received).toBe(5);
    expect(withCollection(seg, 99_999).schedule?.received).toBe(10);
  });
  it('recordWeek clamps at [0, weeks] and reverses with a negative delta', () => {
    const seg = { gross: 2_000, collected: null, schedule: { mode: 'weekly' as const, weeks: 10, received: 9, startDate: null } };
    expect(recordWeek(seg, 1)?.schedule?.received).toBe(10);
    expect(recordWeek({ ...seg, ...recordWeek(seg, 1) }, 1)?.schedule?.received).toBe(10);
    expect(recordWeek(seg, -1)?.schedule?.received).toBe(8);
    expect(recordWeek({ gross: 10, collected: 0, schedule: null })).toBeNull();
  });
  it('scheduleFor builds a schedule only for weekly lenders', () => {
    expect(scheduleFor({ name: 'ROWAN', terms: 'weekly', weeks: 20 }, '2026-07-17')).toEqual({ mode: 'weekly', weeks: 20, received: 0, startDate: '2026-07-17' });
    expect(scheduleFor({ name: 'MBC', terms: 'upfront', weeks: 0 }, '2026-07-17')).toBeNull();
  });
  it('the base segment of a deal reads its collection from the deal columns', () => {
    const d = makeDeal({ id: 'F9', funded: 10_000, commRate: 0.1, commSchedule: { mode: 'weekly', weeks: 4, received: 1, startDate: null } });
    expect(collectedOf(segments(d)[0]!)).toBe(250);
  });
});
