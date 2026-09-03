import { describe, expect, it } from 'vitest';
import { linesInPeriod, monthlySeries, paidFigures, repLedger } from '../src/ledger.js';
import { ctx, line, makeClawback, makeDeal } from './fixtures.js';

// F1: net 1,000 → rep-07 (opener 35%) = 350. F2: net 2,000 → rep-07 = 700.
const F1 = makeDeal({ id: 'F1', date: '2026-06-05', funded: 10_000, commRate: 0.1 });
const F2 = makeDeal({ id: 'F2', date: '2026-07-12', funded: 20_000, commRate: 0.1 });

describe('repLedger — invariant #1: one definition of a rep\'s money', () => {
  it('earned sums the rep\'s share across every deal they are on', () => {
    expect(repLedger(ctx([F1, F2]), 'rep-07').earned).toBe(1_050);
    expect(repLedger(ctx([F1, F2]), 'rep-05').earned).toBe(1_200);
    expect(repLedger(ctx([F1, F2]), 'rep-99')).toMatchObject({ earned: 0, paid: 0, owed: 0, deals: [] });
  });

  it('invariant #2: paid ALWAYS comes from the ledger — never from deal status', () => {
    // F1 is fully collected from the lender and even stamped repPaid, but no ledger row exists.
    const collected = makeDeal({ id: 'F1', funded: 10_000, commRate: 0.1, commCollected: 1_000, repPaid: '2026-06-20' });
    const l = repLedger(ctx([collected]), 'rep-07');
    expect(l.paid).toBe(0);
    expect(l.owed).toBe(350);
    // A ledger row is what makes it paid.
    const l2 = repLedger(ctx([collected], [line('F1|Opener|base', 'rep-07', 350)]), 'rep-07');
    expect(l2.paid).toBe(350);
    expect(l2.owed).toBe(0);
  });

  it('invariant #4: owed = earned − paid(gross) − held, never against net cash', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000); // rep-07 slice = 350
    const rows = [
      line('F1|Opener|base', 'rep-07', 350),
      line('F2|Opener|base', 'rep-07', 700),
      line('cbrec|cb-1|run-2|rep-07', 'rep-07', -350, { role: 'Clawback recovery', clawbackId: 'cb-1', segmentKey: null }),
    ];
    const l = repLedger(ctx([F1, F2], rows, [cb]), 'rep-07');
    expect(l.earned).toBe(1_050);
    expect(l.paid).toBe(1_050); // gross settled
    expect(l.cash).toBe(700); // net of the recovery
    expect(l.recovered).toBe(350);
    expect(l.held).toBe(0); // fully recovered: nothing left to hold
    expect(l.owed).toBe(0); // NOT earned − cash = 350, which would hand the clawback back
  });

  it('held is the REMAINING slice of open clawbacks, so a rep is charged once', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000);
    const rows = [line('cbrec|cb-1|run-2|rep-07', 'rep-07', -200, { role: 'Clawback recovery', clawbackId: 'cb-1', segmentKey: null })];
    const l = repLedger(ctx([F1, F2], rows, [cb]), 'rep-07');
    expect(l.held).toBe(150);
    expect(l.recovered).toBe(200);
    expect(l.owed).toBe(1_050 - 0 - 150);
  });

  it('owed never goes negative', () => {
    const rows = [line('F1|Opener|base', 'rep-07', 350), line('F1|Opener|base', 'rep-07', 350, { key: 'F1|Opener|base#dup', runId: 'run-9' })];
    expect(repLedger(ctx([F1], rows), 'rep-07').owed).toBe(0);
  });

  it('a clawback on a deal the rep is not on does not touch their ledger', () => {
    const other = makeDeal({ id: 'F3', openerId: 'rep-02', closerId: 'rep-05', overrideId: null });
    const cb = makeClawback('cb-x', 'F3', 500);
    expect(repLedger(ctx([F1, other], [], [cb]), 'rep-07')).toMatchObject({ held: 0, recovered: 0, owed: 350 });
  });
});

describe('paidFigures — invariant #6: a paid figure never renders negative', () => {
  it('a period containing only a recovery shows $0 paid and the withholding on its own line', () => {
    const rows = [line('cbrec|cb-1|run-3|rep-07', 'rep-07', -672, { role: 'Clawback recovery', clawbackId: 'cb-1', segmentKey: null, paidAt: '2026-08-20' })];
    expect(paidFigures(rows)).toEqual({ gross: 0, recovered: 672, cash: -672, lineCount: 0 });
    expect(paidFigures(rows).gross).toBeGreaterThanOrEqual(0);
  });
  it('gross − recovered = cash', () => {
    const rows = [line('F1|Opener|base', 'rep-07', 1_000), line('cbrec|cb-1|run-3|rep-07', 'rep-07', -672, { role: 'Clawback recovery', clawbackId: 'cb-1', segmentKey: null })];
    expect(paidFigures(rows)).toEqual({ gross: 1_000, recovered: 672, cash: 328, lineCount: 1 });
  });
  it('linesInPeriod buckets by the date the payout cleared', () => {
    const rows = [line('a|Opener|base', 'r', 1, { paidAt: '2026-08-01' }), line('b|Opener|base', 'r', 1, { paidAt: '2026-08-16' })];
    expect(linesInPeriod(rows, '2026-08-01', '2026-08-15')).toHaveLength(1);
  });
});

describe('monthlySeries — invariant #7: earned and paid are on different axes', () => {
  it('earned buckets by funded month; paid buckets by cleared month', () => {
    const rows = [line('F1|Opener|base', 'rep-07', 350, { paidAt: '2026-07-20' })];
    const series = monthlySeries(ctx([F1, F2], rows), 'rep-07', ['2026-06', '2026-07', '2026-08']);
    expect(series).toEqual([
      { month: '2026-06', earned: 350, paid: 0 },
      { month: '2026-07', earned: 700, paid: 350 },
      { month: '2026-08', earned: 0, paid: 0 },
    ]);
  });
});
