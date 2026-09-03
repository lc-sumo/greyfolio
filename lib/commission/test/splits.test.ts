import { describe, expect, it } from 'vitest';
import { dealLines, defaultSplits, houseNet, payableLines, repOptions, repShare, totalRepPayout } from '../src/splits.js';
import { line, makeDeal, makeDraw, reps, teams } from './fixtures.js';

describe('dealLines / repShare', () => {
  it('prices one line per role per segment at segment.net × rate', () => {
    const d = makeDeal({ id: 'F1', funded: 40_000, commRate: 0.08, draws: [makeDraw(1, 25_000, 0.04)] });
    const lines = dealLines(d);
    expect(lines.map((l) => l.key)).toEqual(['F1|Opener|base', 'F1|Closer|base', 'F1|Override|base', 'F1|Opener|D1', 'F1|Closer|D1', 'F1|Override|D1']);
    expect(lines.find((l) => l.key === 'F1|Opener|base')?.amount).toBe(3_200 * 0.35);
    expect(lines.find((l) => l.key === 'F1|Override|D1')?.amount).toBe(50);
  });
  it('opener, closer and override are independent; a rep on two roles gets both', () => {
    const d = makeDeal({ id: 'F2', funded: 10_000, commRate: 0.1, openerId: 'rep-07', closerId: 'rep-07', overrideId: 'rep-02' });
    expect(repShare(d, 'rep-07')).toBe(1_000 * 0.35 + 1_000 * 0.4);
    expect(repShare(d, 'rep-02')).toBe(50);
    expect(repShare(d, 'rep-99')).toBe(0);
    expect(totalRepPayout(d)).toBe(800);
    expect(houseNet(d)).toBe(200);
  });
  it('omits zero-amount lines and unassigned roles', () => {
    const d = makeDeal({ id: 'F3', overrideId: null, closerRate: 0 });
    expect(dealLines(d).map((l) => l.role)).toEqual(['Opener']);
  });
});

describe('payableLines', () => {
  it('excludes lines that already have a positive ledger row', () => {
    const d = makeDeal({ id: 'F4', funded: 10_000, commRate: 0.1 });
    const paid = [line('F4|Opener|base', 'rep-07', 350)];
    expect(payableLines([d], paid).map((l) => l.key)).toEqual(['F4|Closer|base', 'F4|Override|base']);
    expect(payableLines([d], paid, 'rep-07')).toEqual([]);
  });
  it('a negative row does not count as paying a line', () => {
    const d = makeDeal({ id: 'F5', funded: 10_000, commRate: 0.1 });
    const rows = [line('F5|Opener|base', 'rep-07', -100)];
    expect(payableLines([d], rows, 'rep-07').map((l) => l.key)).toEqual(['F5|Opener|base']);
  });
});

describe('defaultSplits', () => {
  it('defaults rates from profiles and the override rep from the opener team leader', () => {
    const opener = reps.find((r) => r.id === 'rep-07')!;
    const closer = reps.find((r) => r.id === 'rep-05')!;
    expect(defaultSplits(opener, closer, reps, teams)).toEqual({ openerRate: 0.35, closerRate: 0.4, overrideId: 'rep-02', overrideRate: 0.05 });
  });
  it('drops the override when the leader is already opener or closer', () => {
    const leader = reps.find((r) => r.id === 'rep-02')!;
    const closer = reps.find((r) => r.id === 'rep-05')!;
    expect(defaultSplits(leader, closer, reps, teams).overrideId).toBeNull();
  });
  it('falls back to the team override rate when the leader has none', () => {
    const t = [{ ...teams[0]!, leaderRepId: 'rep-15' }];
    const opener = reps.find((r) => r.id === 'rep-07')!;
    expect(defaultSplits(opener, null, reps, t)).toMatchObject({ overrideId: 'rep-15', overrideRate: 0.05 });
  });
});

describe('repOptions — invariant #9', () => {
  it('new-deal assignment lists active reps only', () => {
    expect(repOptions(reps, 'assign').map((o) => o.id)).not.toContain('rep-15');
  });
  it('editing an existing deal lists all reps, inactive suffixed', () => {
    const opts = repOptions(reps, 'edit');
    expect(opts.find((o) => o.id === 'rep-15')?.label).toBe('Noah Levine (inactive)');
  });
  it('View-as lists all reps so a departed rep can be settled', () => {
    expect(repOptions(reps, 'view-as').map((o) => o.id)).toContain('rep-15');
  });
});
