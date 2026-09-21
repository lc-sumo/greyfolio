import { describe, expect, it } from 'vitest';
import { projectAccounting } from '@greystone/commission';
import { directCashFlow, profitAndLoss } from '../src/services/accounting.js';
import { readFileSync } from 'node:fs';
import { memoryRepo } from './memory-repo.js';

const projection = async (repo: ReturnType<typeof memoryRepo>) => {
  const ctx = await repo.loadContext();
  return projectAccounting({ deals: ctx.deals, payoutLines: ctx.lines, clawbacks: ctx.clawbacks }).journals;
};

describe('immutable accounting correction chains', () => {
  it('establishes repeatable-read isolation and advisory serialization before source reads', () => {
    const source = readFileSync(new URL('../src/repo.db.ts', import.meta.url), 'utf8');
    const sync = source.slice(source.indexOf('async syncAccounting'), source.indexOf('async listAccountingPeriods'));
    expect(sync).toContain("{ isolationLevel: 'repeatable read' }");
    expect(sync.indexOf('db.$client.reserve()')).toBeLessThan(sync.indexOf('pg_advisory_lock'));
    expect(sync.indexOf('pg_advisory_lock')).toBeLessThan(sync.indexOf('db.transaction'));
    expect(sync.indexOf('db.transaction')).toBeLessThan(sync.indexOf('tx.select().from(commissionDeals)'));
    expect(sync).toContain('tx.select().from(commissionWalletAdjustments)');
    expect(sync).not.toContain('db.select().from(commissionWalletAdjustments)');
    expect(sync).toContain('pg_advisory_unlock');
    expect(sync).toContain('connection.release()');
  });
  it('reverses the effective version and replaces it in the first open period', async () => {
    const repo = memoryRepo();
    expect((await repo.syncAccounting(await projection(repo), '2026-09-08')).inserted).toBeGreaterThan(0);
    const original = (await repo.listJournals({ sourceKey: 'funding:F1:base' }))[0]!;
    await repo.createAccountingPeriod({ start: '2026-06-01', end: '2026-08-31' });
    const historical = (await repo.listAccountingPeriods())[0]!;
    await repo.closeAccountingPeriod(historical.id, 'rep-leor');
    await repo.createAccountingPeriod({ start: '2026-09-15', end: '2026-12-31' });
    repo.data.deals.find((d) => d.id === 'F1')!.gross += 25;

    const result = await repo.syncAccounting(await projection(repo), '2026-09-08');
    expect(result.corrected).toBeGreaterThan(0);
    const chain = (await repo.listJournals()).filter((j) => j.logicalSourceKey === 'funding:F1:base');
    expect(chain).toHaveLength(3);
    expect(chain.slice(1).every((j) => j.date === '2026-09-15' && j.correctionDate === '2026-09-15')).toBe(true);
    expect(chain.find((j) => j.reversalOf === original.id)!.lines).toEqual(
      original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, id: expect.any(String) })),
    );
    expect((await repo.syncAccounting(await projection(repo), '2026-09-08')).existing).toBeGreaterThan(0);
  });

  it('posts reversal-only for removed sources and creates only one chain concurrently', async () => {
    const repo = memoryRepo();
    await repo.syncAccounting(await projection(repo), '2026-09-08');
    await repo.createAccountingPeriod({ start: '2026-09-08', end: '2026-12-31' });
    repo.data.deals.splice(repo.data.deals.findIndex((d) => d.id === 'F3'), 1);
    const next = await projection(repo);
    const [a, b] = await Promise.all([repo.syncAccounting(next, '2026-09-08'), repo.syncAccounting(next, '2026-09-08')]);
    expect(a.removed + b.removed).toBeGreaterThan(0);
    const removed = (await repo.listJournals()).filter((j) => j.logicalSourceKey === 'funding:F3:base');
    expect(removed).toHaveLength(2);
    expect(removed[1]!.reversalOf).toBe(removed[0]!.id);
  });

  it('leaves a mismatch pending without partial writes when no period is open', async () => {
    const repo = memoryRepo();
    await repo.syncAccounting(await projection(repo), '2026-09-08');
    repo.data.deals.find((d) => d.id === 'F1')!.gross += 25;
    const before = (await repo.listJournals()).length;
    const result = await repo.syncAccounting(await projection(repo), '2026-09-08');
    expect(result.pendingProjection).toBeGreaterThan(0);
    expect(result.unresolved.some((x) => x.reason.includes('No permissible open'))).toBe(true);
    expect((await repo.listJournals()).length).toBe(before);
  });

  it('loads each concurrent operational snapshot only after taking the sync lock', async () => {
    const repo = memoryRepo();
    const older = repo.syncAccounting(null, '2026-09-08');
    repo.data.deals.find((d) => d.id === 'F1')!.gross += 25;
    const newer = repo.syncAccounting(null, '2026-09-08');
    await Promise.all([older, newer]);
    const expected = projectAccounting({ deals: repo.data.deals, payoutLines: repo.data.lines, clawbacks: repo.data.clawbacks }).journals.find((j) => j.sourceKey === 'funding:F1:base')!;
    const chain = (await repo.listJournals()).filter((j) => j.logicalSourceKey === expected.sourceKey);
    expect(chain.at(-1)!.fingerprint).toBe(expected.fingerprint);
    expect(chain.at(-1)!.sourceVersion).toBe(1);
  });

  it('nets a same-period correction chain before classifying gross cash flow', async () => {
    const repo = memoryRepo();
    await repo.createAccountingPeriod({ start: '2026-01-01', end: '2026-12-31' });
    await repo.syncAccounting(await projection(repo), '2026-09-08');
    repo.data.deals.find((d) => d.id === 'F1')!.commCollected = 975;
    await repo.syncAccounting(await projection(repo), '2026-09-08');

    const chain = (await repo.listJournals()).filter((j) => j.logicalSourceKey === 'collection:F1:base');
    const cash = directCashFlow(chain, '2026-01-01', '2026-12-31');
    expect(cash).toMatchObject({ inflows: 975, outflows: 0, netCash: 975 });
    expect(cash.entries.map((e) => [e.date, e.amount])).toEqual([['2026-09-08', 975]]);
  });

  it('reports only the effective delta in a later correction period', async () => {
    const repo = memoryRepo();
    await repo.syncAccounting(await projection(repo), '2026-09-08');
    await repo.createAccountingPeriod({ start: '2026-09-15', end: '2026-12-31' });
    repo.data.deals.find((d) => d.id === 'F1')!.commCollected = 975;
    await repo.syncAccounting(await projection(repo), '2026-09-08');

    const chain = (await repo.listJournals()).filter((j) => j.logicalSourceKey === 'collection:F1:base');
    expect(directCashFlow(chain, '2026-06-01', '2026-06-30')).toMatchObject({ inflows: 1_000, outflows: 0, netCash: 1_000 });
    const correctionPeriod = directCashFlow(chain, '2026-09-15', '2026-12-31');
    expect(correctionPeriod).toMatchObject({ inflows: 0, outflows: 25, netCash: -25 });
    expect(correctionPeriod.entries.map((e) => [e.date, e.amount])).toEqual([['2026-09-15', -25]]);
  });

  it('reports January funding and a February authoritative lender receipt in their proper periods', async () => {
    const repo = memoryRepo();
    const deal = repo.data.deals.find((d) => d.id === 'F1')!;
    deal.date = '2026-01-10';
    deal.lenderPaid = '2026-02-05';
    const journals = projectAccounting({ deals: [deal], payoutLines: [], clawbacks: [] }).journals.map((j, i) => ({ ...j, id: `j-${i}`, lines: j.lines.map((l, n) => ({ ...l, id: `l-${i}-${n}` })) }));
    expect(directCashFlow(journals, '2026-01-01', '2026-01-31').netCash).toBe(0);
    expect(directCashFlow(journals, '2026-02-01', '2026-02-28').netCash).toBe(deal.commCollected);
    expect(profitAndLoss(journals, '2026-01-01', '2026-01-31').expenses).toBe(0);
    expect(profitAndLoss(journals, '2026-02-01', '2026-02-28').expenses).toBeGreaterThan(0);
  });
});

describe('reconciliation transaction integrity', () => {
  it('allows only one concurrent reconciliation match for a journal line', async () => {
    const repo = memoryRepo();
    await repo.syncAccounting(await projection(repo), '2026-09-08');
    const line = (await repo.listJournals({ accountCode: '1000' })).flatMap((j) => j.lines).find((l) => l.accountCode === '1000')!;
    const a = await repo.createReconciliation({ accountCode: '1000', statementStart: '2026-01-01', statementDate: '2026-12-31', openingBalance: 0, statementBalance: 1_000, status: 'open', note: null, createdBy: 'rep-leor' });
    const b = await repo.createReconciliation({ accountCode: '1000', statementStart: '2026-01-01', statementDate: '2026-12-31', openingBalance: 0, statementBalance: 1_000, status: 'open', note: null, createdBy: 'rep-leor' });
    const value = (await repo.listJournals()).flatMap((j) => j.lines).find((l) => l.id === line.id)!.debit
      - (await repo.listJournals()).flatMap((j) => j.lines).find((l) => l.id === line.id)!.credit;
    const results = await Promise.allSettled([
      repo.matchReconciliation(a.id, { journalLineId: line.id, amount: value }),
      repo.matchReconciliation(b.id, { journalLineId: line.id, amount: value }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('carries January closing balance into February and keeps January lines unavailable', async () => {
    const repo = memoryRepo();
    await repo.insertJournals([
      { sourceKey: 'bank:jan', sourceType: 'bank', date: '2026-01-15', memo: 'January deposit', fingerprint: 'jan', lines: [{ accountCode: '1000', debit: 100.01, credit: 0 }, { accountCode: '3000', debit: 0, credit: 100.01 }] },
      { sourceKey: 'bank:jan-outstanding', sourceType: 'bank', date: '2026-01-20', memo: 'Outstanding January deposit', fingerprint: 'jan-outstanding', lines: [{ accountCode: '1000', debit: 7, credit: 0 }, { accountCode: '3000', debit: 0, credit: 7 }] },
      { sourceKey: 'bank:feb', sourceType: 'bank', date: '2026-02-15', memo: 'February deposit', fingerprint: 'feb', lines: [{ accountCode: '1000', debit: 20.02, credit: 0 }, { accountCode: '3000', debit: 0, credit: 20.02 }] },
    ]);
    const cash = await repo.listJournals({ accountCode: '1000' });
    const january = await repo.createReconciliation({ accountCode: '1000', statementStart: '2026-01-01', statementDate: '2026-01-31', openingBalance: 0, statementBalance: 100.01, status: 'open', note: null, createdBy: 'rep-leor' });
    await repo.matchReconciliation(january.id, { journalLineId: cash.find((j) => j.sourceKey === 'bank:jan')!.lines[0]!.id, amount: 100.01 });
    await repo.updateReconciliation(january.id, { status: 'completed' });
    const february = await repo.createReconciliation({ accountCode: '1000', statementStart: '2026-02-01', statementDate: '2026-02-28', openingBalance: 100.01, statementBalance: 127.03, status: 'open', note: null, createdBy: 'rep-leor' });
    await expect(repo.matchReconciliation(february.id, { journalLineId: cash.find((j) => j.sourceKey === 'bank:jan')!.lines[0]!.id, amount: 100.01 })).rejects.toThrow();
    await repo.matchReconciliation(february.id, { journalLineId: cash.find((j) => j.sourceKey === 'bank:jan-outstanding')!.lines[0]!.id, amount: 7 });
    await repo.matchReconciliation(february.id, { journalLineId: cash.find((j) => j.sourceKey === 'bank:feb')!.lines[0]!.id, amount: 20.02 });
    await expect(repo.updateReconciliation(february.id, { status: 'completed' })).resolves.toBeUndefined();
  });
});

describe('atomic period close checklist', () => {
  it('rejects close before the initial accounting sync', async () => {
    const repo = memoryRepo();
    const period = await repo.createAccountingPeriod({ start: '2026-01-01', end: '2026-12-31' });
    await expect(repo.closeAccountingPeriod(period.id, 'rep-leor')).rejects.toThrow('Initial accounting sync');
  });

  it('synchronizes a source change and closes only after a balanced tie-out', async () => {
    const repo = memoryRepo();
    const period = await repo.createAccountingPeriod({ start: '2026-01-01', end: '2027-12-31' });
    await repo.syncAccounting(null, '2026-09-08');
    repo.data.deals.find((d) => d.id === 'F1')!.gross += 25;
    const closed = await repo.closeAccountingPeriod(period.id, 'rep-leor');
    expect(closed.checklist).toMatchObject({ corrected: expect.any(Number), unresolved: 0, balanced: true });
    expect(closed.checklist.corrected).toBeGreaterThan(0);
    expect((await repo.listAccountingPeriods())[0]!.status).toBe('closed');
  });

  it('does not close when a changed source has no permissible correction date', async () => {
    const repo = memoryRepo();
    await repo.syncAccounting(null, '2026-09-08');
    const period = await repo.createAccountingPeriod({ start: '2026-01-01', end: '2026-06-30' });
    repo.data.deals.find((d) => d.id === 'F1')!.gross += 25;
    await expect(repo.closeAccountingPeriod(period.id, 'rep-leor')).rejects.toThrow('unresolved source');
    expect((await repo.listAccountingPeriods())[0]!.status).toBe('open');
  });
});