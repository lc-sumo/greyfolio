import { describe, expect, it } from 'vitest';
import { scheduleFor } from '../src/collection.js';
import { repLedger } from '../src/ledger.js';
import { applyPayout, planPayout } from '../src/payroll.js';
import { dealLines, isDealFullyPaid, payableLines, repShare, unitsPaid } from '../src/splits.js';
import { ctx, line, makeDeal } from './fixtures.js';

const rowan = { name: 'ROWAN', terms: 'weekly' as const, weeks: 20 };
// $100,000 consolidation @ 10% → gross/net 10,000; Julian opener 35% → 3,500 over the deal.
const consol = (received: number, extra: Parameters<typeof scheduleFor>[2] = {}) =>
  makeDeal({ id: 'F9', funded: 100_000, commRate: 0.1, lender: 'ROWAN', commCollected: null, commSchedule: { ...scheduleFor(rowan, '2026-06-01', extra)!, received }, closerId: null, overrideId: null });

describe('payable units on incremental segments', () => {
  it('one unit per lender receipt, priced on that receipt; the sum is the rep share', () => {
    const d = consol(4);
    const mine = dealLines(d).filter((l) => l.repId === 'rep-07');
    expect(mine).toHaveLength(20);
    expect(mine[0]).toMatchObject({ key: 'F9|Opener|base|u1', amount: 175, collected: true, segmentLabel: 'Initial · Increment 1', unit: { n: 1, kind: 'increment' } });
    expect(mine[4]).toMatchObject({ key: 'F9|Opener|base|u5', collected: false });
    expect(mine.reduce((s, l) => s + l.amount, 0)).toBe(3_500);
    expect(repShare(d, 'rep-07')).toBe(3_500);
  });
  it('50 upfront + rest at the end → two units; increments carry no money', () => {
    const d = consol(20, { increments: 20, upfrontPct: 0.5, remainder: 'at-end' });
    const mine = dealLines(d).filter((l) => l.repId === 'rep-07');
    expect(mine.map((l) => [l.key, l.amount, l.collected])).toEqual([['F9|Opener|base|u0', 1_750, false], ['F9|Opener|base|u21', 1_750, false]]);
  });
  it('a plain upfront segment is still one whole line', () => {
    const d = makeDeal({ id: 'F1', funded: 10_000, commRate: 0.1, commCollected: 1_000 });
    expect(dealLines(d).map((l) => l.key)).toEqual(['F1|Opener|base', 'F1|Closer|base', 'F1|Override|base']);
    expect(dealLines(d)[0]!.collected).toBe(true);
  });
});

describe('paying increments as they land', () => {
  it('pays the 4 collected units, leaves 16 payable, and counts increments paid', () => {
    let state = ctx([consol(4)]);
    const payable = payableLines(state.deals, state.lines, 'rep-07');
    const collected = payable.filter((l) => l.collected).map((l) => l.key);
    expect(collected).toHaveLength(4);
    const plan = planPayout(state, { repId: 'rep-07', selectedKeys: collected, runId: 'run-4', paidAt: '2026-07-01' });
    expect(plan.gross).toBe(700);
    expect(plan.uncollectedDealIds).toEqual([]);
    expect(plan.dealsFullyPaid).toEqual([]);
    state = applyPayout(state, plan);
    expect(unitsPaid(state.deals[0]!, state.lines, 'rep-07', 'base')).toEqual({ paid: 4, total: 20, collected: 4 });
    expect(payableLines(state.deals, state.lines, 'rep-07')).toHaveLength(16);
    expect(repLedger(state, 'rep-07')).toMatchObject({ earned: 3_500, accrued: 700, paid: 700, owed: 0, awaitingLender: 2_800 });
    // lender pays 6 more → those 6 increments accrue to the rep's ledger: 6 collected units payable, still 10 uncollected
    state = { ...state, deals: [consol(10)] };
    expect(repLedger(state, 'rep-07')).toMatchObject({ earned: 3_500, accrued: 1_750, paid: 700, owed: 1_050, awaitingLender: 1_750 });
    const next = payableLines(state.deals, state.lines, 'rep-07');
    expect(next.filter((l) => l.collected)).toHaveLength(6);
    expect(next.filter((l) => !l.collected)).toHaveLength(10);
    // paying an uncollected unit is allowed but flagged
    const early = planPayout(state, { repId: 'rep-07', selectedKeys: ['F9|Opener|base|u20'], runId: 'run-4', paidAt: '2026-07-01' });
    expect(early.uncollectedDealIds).toEqual(['F9']);
    // paying an already-paid unit is refused
    expect(() => planPayout(state, { repId: 'rep-07', selectedKeys: ['F9|Opener|base|u1'], runId: 'run-5', paidAt: '2026-07-15' })).toThrow(/already paid/);
  });
  it('repPaid is stamped only when every unit of every segment is paid', () => {
    let state = ctx([consol(20)]);
    const all = payableLines(state.deals, state.lines, 'rep-07').map((l) => l.key);
    const plan = planPayout(state, { repId: 'rep-07', selectedKeys: all, runId: 'run-4', paidAt: '2026-11-01' });
    expect(plan.dealsFullyPaid).toEqual(['F9']);
    state = applyPayout(state, plan);
    expect(isDealFullyPaid(state.deals[0]!, state.lines)).toBe(true);
    expect(unitsPaid(state.deals[0]!, state.lines, 'rep-07', 'base')).toEqual({ paid: 20, total: 20, collected: 20 });
  });
  it('a legacy whole-segment ledger row keeps an incremental segment fully paid', () => {
    const state = ctx([consol(20)], [line('F9|Opener|base', 'rep-07', 3_500)]);
    expect(payableLines(state.deals, state.lines, 'rep-07')).toEqual([]);
    expect(isDealFullyPaid(state.deals[0]!, state.lines)).toBe(true);
    expect(unitsPaid(state.deals[0]!, state.lines, 'rep-07', 'base')).toEqual({ paid: 20, total: 20, collected: 20 });
    expect(repLedger(state, 'rep-07')).toMatchObject({ earned: 3_500, paid: 3_500, owed: 0 });
  });
});
