import { describe, expect, it } from 'vitest';
import { repLedger, paidFigures } from '../src/ledger.js';
import { applyPayout, planPayout } from '../src/payroll.js';
import { payableLines, paidKeys } from '../src/splits.js';
import { applyVoid, planVoid, rowBase } from '../src/void.js';
import { ctx, makeClawback, makeDeal } from './fixtures.js';

// F1: net 1,000 → rep-07 opener 350. F2: net 2,000 → rep-07 opener 700. Both collected.
// rep-07 is the only rep on both, so a paid line is a fully paid deal.
const F1 = makeDeal({ id: 'F1', date: '2026-06-05', funded: 10_000, commRate: 0.1, commCollected: 1_000, closerId: null, overrideId: null });
const F2 = makeDeal({ id: 'F2', date: '2026-07-12', funded: 20_000, commRate: 0.1, commCollected: 2_000, closerId: null, overrideId: null });

describe('voiding a payout', () => {
  it('reverses the rows, makes the lines payable again, and re-paying keeps keys unique', () => {
    let state = ctx([F1, F2]);
    state = applyPayout(state, planPayout(state, { repId: 'rep-07', selectedKeys: ['F1|Opener|base', 'F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' }));
    expect(repLedger(state, 'rep-07')).toMatchObject({ paid: 1_050, owed: 0 });
    expect(state.deals[0]!.repPaid).toBe('2026-09-02');
    const plan = planVoid(state, { repId: 'rep-07', runId: 'run-4', keys: ['F1|Opener|base'], paidAt: '2026-09-03' });
    expect(plan.lines).toEqual([expect.objectContaining({ key: 'void|F1|Opener|base', role: 'Void', amount: -350, voids: 'F1|Opener|base', dealId: 'F1' })]);
    expect(plan.reversed).toBe(350);
    expect(plan.dealsUnstamped).toEqual(['F1']);
    state = applyVoid(state, plan);
    expect(state.deals[0]!.repPaid).toBeNull();
    expect(repLedger(state, 'rep-07')).toMatchObject({ paid: 700, cash: 700, owed: 350 });
    expect(paidKeys(state.lines).has('F1|Opener|base')).toBe(false);
    expect(payableLines(state.deals, state.lines, 'rep-07').map((l) => l.key)).toEqual(['F1|Opener|base']);
    // paid figures for the run: gross drops, voided is reported
    expect(paidFigures(state.lines.filter((l) => l.runId === 'run-4'))).toMatchObject({ gross: 700, voided: 350, cash: 700 });
    // re-pay: the new row cannot reuse the unique key
    const again = planPayout(state, { repId: 'rep-07', selectedKeys: ['F1|Opener|base'], runId: 'run-5', paidAt: '2026-09-15' });
    expect(again.lines[0]!.key).toBe('F1|Opener|base#2');
    expect(rowBase(again.lines[0]!.key)).toBe('F1|Opener|base');
    state = applyPayout(state, again);
    expect(repLedger(state, 'rep-07')).toMatchObject({ paid: 1_050, owed: 0 });
    expect(state.deals[0]!.repPaid).toBe('2026-09-15');
    // voiding twice is refused
    expect(() => planVoid(state, { repId: 'rep-07', runId: 'run-4', keys: ['F1|Opener|base'], paidAt: '2026-09-16' })).toThrow(/already voided/);
  });
  it('voiding a payout that withheld a clawback gives the clawback its balance back', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000); // rep-07's slice: 350
    let state = ctx([F1, F2], [], [cb]);
    const plan = planPayout(state, { repId: 'rep-07', selectedKeys: ['F2|Opener|base'], runId: 'run-4', paidAt: '2026-09-02' });
    expect(plan).toMatchObject({ gross: 700, withheld: 350, net: 350 });
    state = applyPayout(state, plan);
    expect(state.clawbacks[0]).toMatchObject({ recovered: 350, status: 'recovered' });
    expect(repLedger(state, 'rep-07')).toMatchObject({ paid: 700, recovered: 350, held: 0, cash: 350 });
    const v = planVoid(state, { repId: 'rep-07', runId: 'run-4', paidAt: '2026-09-03' });
    expect(v.lines).toHaveLength(2);
    expect(v).toMatchObject({ reversed: 700, recoveriesReturned: 350 });
    state = applyVoid(state, v);
    expect(state.clawbacks[0]).toMatchObject({ recovered: 0, status: 'open' });
    expect(repLedger(state, 'rep-07')).toMatchObject({ paid: 0, recovered: 0, held: 350, cash: 0, owed: 700 }); // both deals collected, nothing paid, 350 held
  });
});
