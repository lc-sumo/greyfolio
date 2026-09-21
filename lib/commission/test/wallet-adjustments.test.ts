import { describe, expect, it } from 'vitest';
import { repLedger } from '../src/ledger.js';
import { projectAccounting, assertBalanced } from '../src/accounting.js';
import { ctx, line, makeDeal } from './fixtures.js';

const base = makeDeal({ id: 'ADJ-1', business: 'Adjustment Business', funded: 10_000, commRate: 0.1, commCollected: 1_000 });
const adjustment = (id: string, amount: number, reversalOf: string | null = null) => ({
  id, idempotencyKey: id, dealId: 'ADJ-1', repId: 'rep-07', amount, reason: 'Test correction',
  effectiveDate: '2026-06-20', actorRepId: 'rep-admin', reversalOf, createdAt: '2026-06-20T00:00:00.000Z',
});

describe('wallet adjustments', () => {
  it('positive and negative adjustments affect only the signed owed balance', () => {
    const before = repLedger(ctx([base], [line('ADJ-1|Opener|base', 'rep-07', 350)]), 'rep-07');
    const plus = repLedger({ ...ctx([base], [line('ADJ-1|Opener|base', 'rep-07', 350)]), adjustments: [adjustment('a+', 125)] }, 'rep-07');
    const minus = repLedger({ ...ctx([base], [line('ADJ-1|Opener|base', 'rep-07', 350)]), adjustments: [adjustment('a-', -125)] }, 'rep-07');
    expect(plus.balance).toBe(before.balance + 125);
    expect(minus.balance).toBe(before.balance - 125);
    expect(plus).toMatchObject({ earned: before.earned, accrued: before.accrued, paid: before.paid, cash: before.cash });
  });
  it('exact reversal nets to zero and journals are balanced and dimensioned', () => {
    const input = { deals: [base], payoutLines: [], clawbacks: [], adjustments: [adjustment('a+', 125), adjustment('a-rev', -125, 'a+')] };
    const journals = projectAccounting(input).journals.filter((j) => j.sourceType.startsWith('wallet_adjustment'));
    expect(journals).toHaveLength(2);
    for (const journal of journals) { assertBalanced(journal); expect(journal.lines.every((l) => l.dealId === 'ADJ-1' && l.repId === 'rep-07')).toBe(true); }
    expect(repLedger({ ...ctx([base]), adjustments: input.adjustments }, 'rep-07').balance).toBe(350);
    expect(journals[1]!.lines).toEqual(journals[0]!.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })));
  });
});