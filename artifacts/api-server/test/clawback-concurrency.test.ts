import { describe, expect, it } from 'vitest';
import { deleteClawback, recordClawback, updateClawback, updateTerms } from '../src/services/deals.js';
import { memoryRepo } from './memory-repo.js';

const actor = 'rep-leor';
const date = '2026-08-15';

describe('locked clawback lifecycle service', () => {
  it('serializes concurrent creates at the active lender-basis cap and gives each created row a UUID', async () => {
    const repo = memoryRepo();
    const results = await Promise.allSettled([
      recordClawback(repo, 'F2', { amount: 1_500, date }, actor),
      recordClawback(repo, 'F2', { amount: 1_500, date }, actor),
    ]);
    const created = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    expect(created).toHaveLength(1);
    expect(created[0]!.id).toMatch(/^cb-[0-9a-f-]{36}$/);
    expect(new Set(created.map((clawback) => clawback.id)).size).toBe(created.length);
    expect(repo.data.clawbacks.filter((clawback) => clawback.dealId === 'F2' && !clawback.forgivenAt).reduce((sum, clawback) => sum + clawback.amount, 0)).toBeLessThanOrEqual(2_000);
  });

  it('serializes concurrent edits so active clawbacks cannot exceed the basis', async () => {
    const repo = memoryRepo();
    const first = await recordClawback(repo, 'F2', { amount: 500, date }, actor);
    const second = await recordClawback(repo, 'F2', { amount: 500, date }, actor);
    const results = await Promise.allSettled([
      updateClawback(repo, 'F2', first.id, { amount: 1_500 }, actor),
      updateClawback(repo, 'F2', second.id, { amount: 1_500 }, actor),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(repo.data.clawbacks.filter((clawback) => clawback.dealId === 'F2' && !clawback.forgivenAt).reduce((sum, clawback) => sum + clawback.amount, 0)).toBeLessThanOrEqual(2_000);
  });

  it('rejects a lender-basis reduction below active clawbacks without changing the deal', async () => {
    const repo = memoryRepo();
    await recordClawback(repo, 'F2', { amount: 1_500, date }, actor);
    await expect(updateTerms(repo, 'F2', { amount: 10_000 }, actor)).rejects.toThrow(/together they cannot exceed the lender-paid commission basis/i);
    expect(repo.data.deals.find((deal) => deal.id === 'F2')!.funded).toBe(20_000);
  });

  it('forgives after recovery is effectively voided while retaining history, but rejects standing recovery', async () => {
    const rejected = memoryRepo();
    await expect(deleteClawback(rejected, 'F1', 'cb-1', actor)).rejects.toThrow(/repaid on this clawback/i);

    const repo = memoryRepo();
    const recovery = repo.data.lines.find((line) => line.clawbackId === 'cb-1')!;
    repo.data.lines.push({
      key: 'void-cbrec-1',
      dealId: recovery.dealId,
      segmentKey: recovery.segmentKey,
      role: 'Void',
      repId: recovery.repId,
      amount: -recovery.amount,
      runId: recovery.runId,
      clawbackId: recovery.clawbackId,
      paidAt: '2026-09-01',
      voids: recovery.key,
    });
    await deleteClawback(repo, 'F1', 'cb-1', actor);
    expect(repo.data.clawbacks.find((clawback) => clawback.id === 'cb-1')?.forgivenAt).toBeTruthy();
    expect(repo.data.lines.some((line) => line.key === recovery.key)).toBe(true);
    expect((await repo.loadContext()).clawbacks.some((clawback) => clawback.id === 'cb-1')).toBe(false);
  });
});