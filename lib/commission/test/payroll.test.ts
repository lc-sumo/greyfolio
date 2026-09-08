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
    const plan = planPayout(ctx([{ ...F1, commCollected: 0 }, F2], [], [cb]), { repId: 'rep-07', selectedKeys: ['F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
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
    let state = ctx([{ ...F1, commCollected: 0 }, F2], [], [cb]);

    const first = planPayout(state, { repId: 'rep-07', selectedKeys: ['F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    state = applyPayout(state, first);
    expect(repLedger(state, 'rep-07')).toMatchObject({ earned: 1_050, paid: 700, cash: 350, held: 0, recovered: 350, owed: 0 });

    // The lender later pays F1; its original commission can now clear.
    state = { ...state, deals: state.deals.map((d) => d.id === 'F1' ? { ...d, commCollected: 1_000 } : d) };
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

  it('recovers a post-payout lender-only liability from next earnings without altering PSF payout history', () => {
    const lenderAndPsf = makeDeal({
      id: 'L-PSF', funded: 10_000, commRate: 0.08, psfPct: 0.02, commCollected: 1_000,
      closerId: null, overrideId: null, openerRate: 0.35,
    });
    const future = makeDeal({
      id: 'NEXT', funded: 10_000, commRate: 0.1, commCollected: 1_000,
      closerId: null, overrideId: null, openerRate: 0.35,
    });
    const original = line('L-PSF|Opener|base', 'rep-07', 350);
    const cb = makeClawback('cb-lender-only', 'L-PSF', 800);
    const before = ctx([lenderAndPsf], [original], [cb]);
    // Original $350 was paid on gross (including PSF) and remains immutable;
    // new clawback debt is only 35% of $800 lender commission.
    expect(repLedger(before, 'rep-07')).toMatchObject({ paid: 350, held: 280, balance: -280, payable: 0 });
    expect(before.lines).toEqual([original]);

    // Once a new collected $350 earning arrives, the canonical balance can
    // release only $70 cash and must recover the $280 lender-only liability.
    const withFutureEarning = { ...before, deals: [...before.deals, future] };
    expect(repLedger(withFutureEarning, 'rep-07')).toMatchObject({ balance: 70, payable: 70 });
    const plan = planPayout(withFutureEarning, { repId: 'rep-07', selectedKeys: ['NEXT|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(plan).toMatchObject({ gross: 350, withheld: 280, net: 70 });
    expect(plan.recoveries).toEqual([expect.objectContaining({ clawbackId: 'cb-lender-only', amount: -280 })]);
    const after = applyPayout(withFutureEarning, plan);
    expect(after.lines.find((row) => row.key === original.key)).toEqual(original);
    expect(repLedger(after, 'rep-07')).toMatchObject({ held: 0, balance: 0, payable: 0 });
  });

  it('uses append-only keys for sequential partial recoveries in the same run', () => {
    const liability = makeDeal({ id: 'L', commCollected: 0, closerId: null, overrideId: null, openerRate: 1 });
    const p1 = makeDeal({ id: 'P1', funded: 6_000, commCollected: 600, closerId: null, overrideId: null, openerRate: 1 });
    const p2 = makeDeal({ id: 'P2', funded: 6_000, commCollected: 600, closerId: null, overrideId: null, openerRate: 1 });
    const p3 = makeDeal({ id: 'P3', funded: 8_000, commCollected: 800, closerId: null, overrideId: null, openerRate: 1 });
    let state = ctx([liability, p1, p2, p3], [], [makeClawback('cb-partial', 'L', 1_000)]);

    state = applyPayout(state, planPayout(state, { repId: 'rep-07', selectedKeys: ['P1|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' }));
    const partial = planPayout(state, { repId: 'rep-07', selectedKeys: ['P2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(partial.recoveries).toEqual([expect.objectContaining({ key: 'cbrec|cb-partial|run-4|rep-07', amount: -200, clawbackId: 'cb-partial' })]);
    state = applyPayout(state, partial);
    const remainder = planPayout(state, { repId: 'rep-07', selectedKeys: ['P3|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(remainder.recoveries).toEqual([expect.objectContaining({ key: 'cbrec|cb-partial|run-4|rep-07#2', amount: -800, clawbackId: 'cb-partial' })]);
    expect(new Set([...state.lines, ...remainder.lines, ...remainder.recoveries].map((row) => row.key)).size).toBe(state.lines.length + remainder.lines.length + remainder.recoveries.length);
  });

  it('withholds only up to the payout gross and carries the rest forward', () => {
    const cb = makeClawback('cb-1', 'F2', 2_000); // rep-07 owes 700
    let state = ctx([F1, F2], [], [cb]);
    const first = planPayout(state, { repId: 'rep-07', selectedKeys: ['F1|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(first).toMatchObject({ gross: 350, withheld: 0, net: 350 });
    state = applyPayout(state, first);
    expect(repLedger(state, 'rep-07')).toMatchObject({ paid: 350, cash: 350, held: 700, recovered: 0, owed: 0 });
    expect(clawbackQueue(state, 'rep-07')).toEqual([{ clawback: state.clawbacks[0], remaining: 700 }]);

    const second = planPayout(state, { repId: 'rep-07', selectedKeys: ['F2|Opener|base'], runId: 'run-5', paidAt: '2026-09-17' });
    expect(second).toMatchObject({ gross: 700, withheld: 700, net: 0 });
    state = applyPayout(state, second);
    expect(repLedger(state, 'rep-07')).toMatchObject({ earned: 1_050, paid: 1_050, cash: 350, held: 0, recovered: 700, owed: 0 });
    expect(state.lines.filter((x) => x.role === 'Clawback recovery').map((x) => x.amount)).toEqual([-700]);
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
    expect(state.clawbacks[0]).toMatchObject({ recovered: 0, status: 'open' });
    // rep-05 is still owed their F2 closer line (800); nothing more is held against them.
    expect(repLedger(state, 'rep-05')).toMatchObject({ earned: 1_200, paid: 400, cash: 400, held: 400, recovered: 0, owed: 400 });
    expect(repLedger(state, 'rep-02')).toMatchObject({ earned: 150, paid: 50, cash: 50, held: 50, recovered: 0, owed: 50 });
  });

  it('stamps repPaid only when every line on every segment is paid', () => {
    const loc = makeDeal({ id: 'F9', funded: 40_000, commRate: 0.08, commCollected: 3_200, product: 'LOC - INITIAL', drawSubsequentPct: 0.04, draws: [makeDraw(1, 25_000, 0.04, { collected: 1_000 })], openerId: 'rep-07', closerId: 'rep-07', overrideId: null });
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

  it('rejects an uncollected advance that cannot be covered by clawback recovery', () => {
    const open = { ...F2, commCollected: 0 };
    expect(() => planPayout(ctx([F1, open]), { repId: 'rep-07', selectedKeys: ['F1|Opener|base', 'F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' })).toThrow(/uncollected advances cannot be paid/);
  });

  it('payoutPreview matches the plan', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000);
    const c = ctx([F1, F2], [], [cb]);
    expect(payoutPreview(c, 'rep-07', ['F2|Opener|base'])).toEqual({ gross: 700, withheld: 0, net: 700, outstandingClawback: 350 });
    expect(payoutPreview(c, 'rep-07', [])).toEqual({ gross: 0, withheld: 0, net: 0, outstandingClawback: 350 });
  });

  it('never charges a retained forgiven clawback against future collected earnings', () => {
    const forgiven = makeClawback('cb-forgiven', 'F1', 1_000, { forgivenAt: '2026-08-30' });
    const c = ctx([{ ...F1, commCollected: 0 }, F2], [], [forgiven]);
    const preview = payoutPreview(c, 'rep-07', ['F2|Opener|base']);
    const plan = planPayout(c, { repId: 'rep-07', selectedKeys: ['F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });

    expect(preview).toEqual({ gross: 700, withheld: 0, net: 700, outstandingClawback: 0 });
    expect(plan).toMatchObject({ gross: preview.gross, withheld: preview.withheld, net: preview.net });
    expect(plan.recoveries).toEqual([]);
    expect(plan.clawbackUpdates).toEqual([]);

    const after = applyPayout(c, plan);
    expect(after.lines.some((row) => row.clawbackId === forgiven.id)).toBe(false);
    expect(repLedger(c, 'rep-07')).toMatchObject({ held: 0, balance: 700, payable: 700 });
    expect(repLedger(after, 'rep-07')).toMatchObject({ held: 0, balance: 0, payable: 0 });
  });
});
