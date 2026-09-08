import { describe, expect, it } from 'vitest';
import { planVoid } from '@greystone/commission';
import { memoryRepo } from './memory-repo.js';

describe('clawback repository lifecycle', () => {
  it('treats legacy rows without a forgiveness timestamp as active', async () => {
    const repo = memoryRepo();
    const context = await repo.loadContext();
    expect(context.clawbacks.map((c) => c.id)).toContain('cb-1');
  });

  it('retains a forgiven row and its recovery history but removes it from active context', async () => {
    const repo = memoryRepo();
    await repo.mutateClawback('F1', 'cb-1', ({ clawback, lines }) => {
      expect(clawback?.forgivenAt).toBeNull();
      expect(lines.some((line) => line.clawbackId === 'cb-1')).toBe(true);
      return { result: undefined, forgive: true };
    });
    expect(repo.data.clawbacks.find((c) => c.id === 'cb-1')?.forgivenAt).toBeTruthy();
    expect((await repo.loadContext()).clawbacks.map((c) => c.id)).not.toContain('cb-1');
  });

  it('excludes forgiven rows from locked planning while still allowing an old recovery row to be voided', async () => {
    const repo = memoryRepo();
    repo.data.clawbacks[0] = { ...repo.data.clawbacks[0]!, forgivenAt: '2026-09-01' };

    const result = await repo.planPayoutForRun('run-3', 'rep-julian-ribak', ['paid'], (context) => {
      expect(context.clawbacks.some((clawback) => clawback.id === 'cb-1')).toBe(false);
      const plan = planVoid(context, {
        repId: 'rep-julian-ribak',
        runId: 'run-3',
        keys: ['cbrec|cb-1|run-3|rep-julian-ribak'],
        paidAt: '2026-09-02',
      });
      return {
        result: plan,
        commit: {
          lines: plan.lines,
          clawbackUpdates: plan.clawbackUpdates,
          dealsFullyPaid: [],
          dealsUnstamped: plan.dealsUnstamped,
          paidAt: '2026-09-02',
        },
      };
    });

    expect(result?.recoveriesReturned).toBe(100);
    expect(result?.clawbackUpdates).toEqual([]);
    expect(repo.data.lines.some((line) => line.voids === 'cbrec|cb-1|run-3|rep-julian-ribak')).toBe(true);
    expect(repo.data.clawbacks[0]?.forgivenAt).toBe('2026-09-01');
  });

  it('serializes concurrent lifecycle callbacks for the same deal', async () => {
    const repo = memoryRepo();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const first = repo.mutateClawback('F1', 'cb-1', async () => {
      await waiting;
      return { result: undefined, update: { amount: 200 } };
    });
    // Allow the first callback to claim the in-memory parent-deal lock.
    await Promise.resolve();
    const second = repo.mutateClawback('F1', 'cb-1', ({ clawback }) => ({
      result: clawback!.amount,
      update: { amount: clawback!.amount + 1 },
    }));
    release();
    await first;
    expect(await second).toBe(200);
    expect(repo.data.clawbacks.find((c) => c.id === 'cb-1')?.amount).toBe(201);
  });
});