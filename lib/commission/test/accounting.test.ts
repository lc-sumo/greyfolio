import { describe, expect, it } from 'vitest';
import { assertBalanced, projectAccounting } from '../src/accounting.js';
import type { PayoutLine } from '../src/types.js';
import { makeDeal, makeDraw } from './fixtures.js';

describe('unified accounting projection', () => {
  it('is cent-balanced and deterministic from the earliest source date', () => {
    const later = makeDeal({ id: 'F2', date: '2026-02-01', funded: 3333.33, commRate: 0.1, commCollected: 333.33 });
    const first = makeDeal({ id: 'F1', date: '2026-01-02', funded: 1000, commRate: 0.1, commCollected: 100 });
    const a = projectAccounting({ deals: [later, first], payoutLines: [], clawbacks: [] });
    const b = projectAccounting({ deals: [first, later], payoutLines: [], clawbacks: [] });
    expect(a.journals.map((j) => j.sourceKey)).toEqual(b.journals.map((j) => j.sourceKey));
    expect(a.journals[0]!.date).toBe('2026-01-02');
    a.journals.forEach(assertBalanced);
  });
  it('clears referral payable for base plus draw fees', () => {
    const deal = makeDeal({ id: 'F1', referralPartner: 'Partner', referralRate: 0.1 });
    deal.referralPaidAt = '2026-02-01';
    deal.draws = [makeDraw(1, 1000, 0.1, { referralFee: 10, gross: 100, net: 90 })];
    const payment = projectAccounting({ deals: [deal], payoutLines: [], clawbacks: [] }).journals.find((j) => j.sourceKey === 'referral-payment:F1')!;
    expect(payment.lines[0]!.debit).toBe(deal.referralFee + 10);
  });
  it('puts explicit rep and deal dimensions on every rep-payable line', () => {
    const deal = makeDeal({ id: 'F1', funded: 1_000, commCollected: 100 });
    const journals = projectAccounting({ deals: [deal], payoutLines: [], clawbacks: [] }).journals;
    const payable = journals.flatMap((j) => j.lines).filter((l) => l.accountCode === '2000');
    expect(payable.length).toBeGreaterThan(0);
    expect(payable.every((l) => l.dealId === 'F1' && !!l.repId)).toBe(true);
    expect(payable.reduce((n, l) => n + l.credit - l.debit, 0)).toBe(
      journals.flatMap((j) => j.lines).filter((l) => l.accountCode === '5000').reduce((n, l) => n + l.debit - l.credit, 0),
    );
  });
  it('uses a February authoritative receipt for collection and rep accrual on a January funding', () => {
    const deal = makeDeal({ id: 'F1', date: '2026-01-10', funded: 1_000, commRate: 0.1, commCollected: 100 });
    deal.lenderPaid = '2026-02-05';
    const projection = projectAccounting({ deals: [deal], payoutLines: [], clawbacks: [] });
    expect(projection.journals.find((j) => j.sourceKey === 'funding:F1:base')!.date).toBe('2026-01-10');
    expect(projection.journals.find((j) => j.sourceKey === 'collection:F1:base')!.date).toBe('2026-02-05');
    expect(projection.journals.filter((j) => j.sourceKey.startsWith('rep-accrual:F1|')).every((j) => j.date === '2026-02-05')).toBe(true);
    expect(projection.assumedCollectionDates).toHaveLength(0);
  });
  it('posts the complete recovery lifecycle and exactly reverses a voided recovery', () => {
    const deal = makeDeal({ id: 'F1', funded: 1_000, commRate: 0.1, commCollected: 100 });
    const payoutLines: PayoutLine[] = [
      { key: 'cbrec|cb-1|run-1|rep-07', dealId: 'F1', segmentKey: null, role: 'Clawback recovery', repId: 'rep-07', amount: -35, runId: 'run-1', clawbackId: 'cb-1', paidAt: '2026-08-20' },
      { key: 'void|cbrec|cb-1|run-1|rep-07', dealId: 'F1', segmentKey: null, role: 'Void', repId: 'rep-07', amount: 35, runId: 'run-1', clawbackId: 'cb-1', paidAt: '2026-08-21', voids: 'cbrec|cb-1|run-1|rep-07' },
    ];
    const journals = projectAccounting({
      deals: [deal],
      payoutLines,
      clawbacks: [{ id: 'cb-1', dealId: 'F1', date: '2026-08-15', amount: 100, recovered: 0, reason: 'default', status: 'open' }],
    }).journals;
    const golden = (sourceKey: string) => journals.find((j) => j.sourceKey === sourceKey)!.lines
      .map(({ accountCode, debit, credit }) => ({ accountCode, debit, credit }));

    expect(golden('clawback:cb-1')).toEqual([
      { accountCode: '4090', debit: 100, credit: 0 },
      { accountCode: '1100', debit: 0, credit: 100 },
    ]);
    expect(golden('clawback-recovery-accrual:cb-1:rep-07')).toEqual([
      { accountCode: '1200', debit: 35, credit: 0 },
      { accountCode: '4090', debit: 0, credit: 35 },
    ]);
    expect(golden('payout:cbrec|cb-1|run-1|rep-07')).toEqual([
      { accountCode: '1000', debit: 35, credit: 0 },
      { accountCode: '1200', debit: 0, credit: 35 },
    ]);
    expect(golden('payout:void|cbrec|cb-1|run-1|rep-07')).toEqual([
      { accountCode: '1000', debit: 0, credit: 35 },
      { accountCode: '1200', debit: 35, credit: 0 },
    ]);
    expect(golden('payout:void|cbrec|cb-1|run-1|rep-07').some((l) => l.accountCode === '2000')).toBe(false);
  });

  it('uses the referenced journal amount and accounts as the void golden source', () => {
    const payoutLines: PayoutLine[] = [
      { key: 'F1|Opener|base', dealId: 'F1', segmentKey: 'base', role: 'Opener', repId: 'rep-07', amount: 350, runId: 'run-1', clawbackId: null, paidAt: '2026-08-20' },
      // The projection must not use this row's amount to invent new economics.
      { key: 'void|F1|Opener|base', dealId: 'F1', segmentKey: 'base', role: 'Void', repId: 'rep-07', amount: -999, runId: 'run-1', clawbackId: null, paidAt: '2026-08-21', voids: 'F1|Opener|base' },
    ];
    const lines = projectAccounting({ deals: [], payoutLines, clawbacks: [] }).journals
      .find((j) => j.sourceKey === 'payout:void|F1|Opener|base')!.lines
      .map(({ accountCode, debit, credit }) => ({ accountCode, debit, credit }));
    expect(lines).toEqual([
      { accountCode: '2000', debit: 0, credit: 350 },
      { accountCode: '1000', debit: 350, credit: 0 },
    ]);
  });
});