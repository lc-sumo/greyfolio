import { describe, expect, it } from 'vitest';
import { repLedger } from '../src/ledger.js';
import { PayoutError, applyPayout, clawbackQueue, payoutPreview, planPayout } from '../src/payroll.js';
import { ctx, line, makeClawback, makeDeal, makeDraw } from './fixtures.js';

// F1: net 1,000 → rep-07 opener 350, rep-05 closer 400, rep-02 override 50.
// F2: net 2,000 → rep-07 opener 700.
const F1 = makeDeal({ id: 'F1', date: '2026-06-05', funded: 10_000, commRate: 0.1, commCollected: 1_000 });
const F2 = makeDeal({ id: 'F2', date: '2026-07-12', funded: 20_000, commRate: 0.1, commCollected: 2_000 });

describe('planPayout', () => {
  it('writes one positive ledger row per selected line, pinned to the rep and run', () => {
    const plan = planPayout(ctx([F1, F2]), { repId: 'rep-07', selectedKeys: ['F1|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(plan.lines).toEqual([
      { key: 'F1|Opener|base', dealId: 'F1', segmentKey: 'base', role: 'Opener', repId: 'rep-07', amount: 350, runId: 'run-4', clawbackId: null, paidAt: '2026-09-02' },
    ]);
    expect(plan).toMatchObject({ repId: 'rep-07', runId: 'run-4', gross: 350, withheld: 0, net: 350, recoveries: [] });
  });

  it('refuses a line that is already paid — a payout is collected exactly once', () => {
    const paid = [line('F1|Opener|base', 'rep-07', 350)];
    expect(() => planPayout(ctx([F1, F2], paid), { repId: 'rep-07', selectedKeys: ['F1|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' })).toThrow(PayoutError);
    expect(() => planPayout(ctx([F1, F2], paid), { repId: 'rep-07', selectedKeys: ['F1|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' })).toThrow(/already paid/);
  });

  it('refuses a line that belongs to another rep, and an empty selection', () => {
    expect(() => planPayout(ctx([F1]), { repId: 'rep-07', selectedKeys: ['F1|Closer|base'], runId: 'run-4', paidAt: '2026-09-02' })).toThrow(/not payable/);
    expect(() => planPayout(ctx([F1]), { repId: 'rep-07', selectedKeys: [], runId: 'run-4', paidAt: '2026-09-02' })).toThrow(/at least one/);
  });

  it('invariant #3: recovering a clawback writes a negative ledger row and updates the roll-up', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000); // rep-07 owes 350
    const plan = planPayout(ctx([F1, F2], [], [cb]), { repId: 'rep-07', selectedKeys: ['F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(plan.gross).toBe(700);
    expect(plan.withheld).toBe(350);
    expect(plan.net).toBe(350);
    expect(plan.recoveries).toEqual([
      { key: 'cbrec|cb-1|run-4|rep-07', dealId: 'F1', segmentKey: null, role: 'Clawback recovery', repId: 'rep-07', amount: -350, runId: 'run-4', clawbackId: 'cb-1', paidAt: '2026-09-02' },
    ]);
    // rep-05 and rep-02 still owe theirs, so the clawback stays open.
    expect(plan.clawbackUpdates).toEqual([{ id: 'cb-1', recovered: 350, status: 'open' }]);
  });

  it('a recovery is collected exactly once across successive runs', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000);
    let state = ctx([F1, F2], [], [cb]);

    const first = planPayout(state, { repId: 'rep-07', selectedKeys: ['F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    state = applyPayout(state, first);
    expect(repLedger(state, 'rep-07')).toMatchObject({ earned: 1_050, paid: 700, cash: 350, held: 0, recovered: 350, owed: 350 });

    // Next run: pay the F1 opener line. Nothing left to withhold — no second recovery row.
    const second = planPayout(state, { repId: 'rep-07', selectedKeys: ['F1|Opener|base'], runId: 'run-5', paidAt: '2026-09-17' });
    expect(second.withheld).toBe(0);
    expect(second.recoveries).toEqual([]);
    state = applyPayout(state, second);
    const l = repLedger(state, 'rep-07');
    expect(l).toMatchObject({ earned: 1_050, paid: 1_050, cash: 700, held: 0, recovered: 350, owed: 0 });
    expect(l.paid - l.recovered).toBe(l.cash);
    expect(state.lines.filter((x) => x.role === 'Clawback recovery')).toHaveLength(1);
    expect(state.clawbacks[0]?.recovered).toBe(350);
  });

  it('withholds only up to the payout gross and carries the rest forward', () => {
    const cb = makeClawback('cb-1', 'F2', 2_000); // rep-07 owes 700
    let state = ctx([F1, F2], [], [cb]);
    const first = planPayout(state, { repId: 'rep-07', selectedKeys: ['F1|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(first).toMatchObject({ gross: 350, withheld: 350, net: 0 });
    state = applyPayout(state, first);
    expect(repLedger(state, 'rep-07')).toMatchObject({ paid: 350, cash: 0, held: 350, recovered: 350, owed: 350 });
    expect(clawbackQueue(state, 'rep-07')).toEqual([{ clawback: state.clawbacks[0], remaining: 350 }]);

    const second = planPayout(state, { repId: 'rep-07', selectedKeys: ['F2|Opener|base'], runId: 'run-5', paidAt: '2026-09-17' });
    expect(second).toMatchObject({ gross: 700, withheld: 350, net: 350 });
    state = applyPayout(state, second);
    expect(repLedger(state, 'rep-07')).toMatchObject({ earned: 1_050, paid: 1_050, cash: 350, held: 0, recovered: 700, owed: 0 });
    expect(state.lines.filter((x) => x.role === 'Clawback recovery').map((x) => x.amount)).toEqual([-350, -350]);
  });

  it('allocates recovery oldest-first across several open clawbacks', () => {
    const older = makeClawback('cb-old', 'F1', 1_000, { date: '2026-07-01' }); // rep-07 owes 350
    const newer = makeClawback('cb-new', 'F2', 400, { date: '2026-08-01' }); // rep-07 owes 700 × 400/2000 = 140
    const F3 = makeDeal({ id: 'F3', funded: 10_000, commRate: 0.1 }); // rep-07 line 350
    const plan = planPayout(ctx([F1, F2, F3], [], [newer, older]), { repId: 'rep-07', selectedKeys: ['F3|Opener|base', 'F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(plan.gross).toBe(1_050);
    expect(plan.recoveries.map((r) => [r.clawbackId, r.amount])).toEqual([['cb-old', -350], ['cb-new', -140]]);
    expect(plan.net).toBe(560);
  });

  it('the clawback flips to recovered only once every rep slice is withheld', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000);
    let state = ctx([F1, F2], [], [cb]);
    for (const [rep, key] of [['rep-07', 'F2|Opener|base'], ['rep-05', 'F1|Closer|base'], ['rep-02', 'F1|Override|base']] as const) {
      const plan = planPayout(state, { repId: rep, selectedKeys: [key], runId: 'run-4', paidAt: '2026-09-02' });
      state = applyPayout(state, plan);
    }
    // rep-05 (400) and rep-02 (50) had their whole F1 line withheld; rep-07 withheld 350.
    expect(state.clawbacks[0]).toMatchObject({ recovered: 800, status: 'recovered' });
    // rep-05 is still owed their F2 closer line (800); nothing more is held against them.
    expect(repLedger(state, 'rep-05')).toMatchObject({ earned: 1_200, paid: 400, cash: 0, held: 0, recovered: 400, owed: 800 });
    expect(repLedger(state, 'rep-02')).toMatchObject({ earned: 150, paid: 50, cash: 0, held: 0, recovered: 50, owed: 100 });
  });

  it('stamps repPaid only when every line on every segment is paid', () => {
    const loc = makeDeal({ id: 'F9', funded: 40_000, commRate: 0.08, product: 'LOC - INITIAL', drawSubsequentPct: 0.04, draws: [makeDraw(1, 25_000, 0.04)], openerId: 'rep-07', closerId: 'rep-07', overrideId: null });
    let state = ctx([loc]);
    const p1 = planPayout(state, { repId: 'rep-07', selectedKeys: ['F9|Opener|base', 'F9|Closer|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(p1.dealsFullyPaid).toEqual([]);
    state = applyPayout(state, p1);
    expect(state.deals[0]?.repPaid).toBeNull();
    const p2 = planPayout(state, { repId: 'rep-07', selectedKeys: ['F9|Opener|D1', 'F9|Closer|D1'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(p2.dealsFullyPaid).toEqual(['F9']);
    state = applyPayout(state, p2);
    expect(state.deals[0]?.repPaid).toBe('2026-09-02');
  });

  it('flags deal ids whose commission the lender has not fully paid', () => {
    const open = { ...F2, commCollected: 0 };
    const plan = planPayout(ctx([F1, open]), { repId: 'rep-07', selectedKeys: ['F1|Opener|base', 'F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(plan.uncollectedDealIds).toEqual(['F2']);
  });

  it('payoutPreview matches the plan', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000);
    const c = ctx([F1, F2], [], [cb]);
    expect(payoutPreview(c, 'rep-07', ['F2|Opener|base'])).toEqual({ gross: 700, withheld: 350, net: 350, outstandingClawback: 350 });
    expect(payoutPreview(c, 'rep-07', [])).toEqual({ gross: 0, withheld: 0, net: 0, outstandingClawback: 350 });
  });
});
