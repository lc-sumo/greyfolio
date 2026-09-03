import { describe, expect, it } from 'vitest';
import { clawbackRecovered, dealCommissionStatus, isDealFullyPaid, repLedger } from '@greystone/commission';
import { buildDemo, demoRuns, demoSummary } from '../src/seed/demo.js';

const TODAY = '2026-09-02';
const demo = buildDemo(TODAY);

describe('demo board', () => {
  it('is deterministic and non-trivial', () => {
    expect(buildDemo(TODAY)).toEqual(demo);
    const s = demoSummary(demo);
    expect(s.deals).toBeGreaterThan(40);
    expect(s.withDraws).toBeGreaterThan(3);
    expect(s.weekly).toBeGreaterThan(3);
    expect(s.paidRuns).toBeGreaterThan(3);
    expect(s.lines).toBeGreaterThan(50);
    expect(s.clawbacks).toBeGreaterThan(0);
    expect(s.recoveries).toBeGreaterThan(0);
  });
  it('never funds a deal or draw in the future', () => {
    for (const d of demo.deals) {
      expect(d.date <= TODAY).toBe(true);
      for (const x of d.draws) expect(x.date <= TODAY).toBe(true);
    }
  });
  it('every clawback roll-up equals its ledger rows, and status is derived', () => {
    for (const c of demo.clawbacks) {
      expect(c.recovered).toBe(clawbackRecovered(demo.lines, c.id));
      if (c.status === 'recovered') expect(c.recovered).toBeGreaterThan(0);
    }
  });
  it('every rep ledger balances: owed = accrued − paid − held, accrued ≤ earned, all non-negative', () => {
    for (const r of demo.reps) {
      const l = repLedger(demo, r.id);
      expect(l.owed).toBeGreaterThanOrEqual(0);
      expect(l.paid).toBeGreaterThanOrEqual(0);
      expect(l.accrued).toBeLessThanOrEqual(l.earned + 0.005);
      expect(l.awaitingLender).toBeCloseTo(l.earned - l.accrued, 2);
      expect(l.paid - l.recovered).toBeCloseTo(l.cash, 2);
      expect(l.owed).toBeCloseTo(Math.max(0, l.accrued - l.paid - l.held), 2);
    }
  });
  it('only consolidations carry increment schedules; LOCs and their draws are paid upfront', () => {
    for (const d of demo.deals) {
      const incremental = d.product.startsWith('CONSOLIDATION');
      if (!incremental) {
        expect(d.commSchedule).toBeNull();
        for (const dr of d.draws) expect(dr.schedule ?? null).toBeNull();
      }
    }
    expect(demo.deals.filter((d) => d.commSchedule).length).toBeGreaterThan(3);
  });
  it('repPaid is stamped only on fully paid deals, and only paid-in-full commission was paid out', () => {
    for (const d of demo.deals) {
      if (d.repPaid) expect(isDealFullyPaid(d, demo.lines)).toBe(true);
      const paidLines = demo.lines.filter((l) => l.dealId === d.id && l.amount > 0);
      if (paidLines.length && d.draws.length === 0) expect(dealCommissionStatus(d)).toBe('YES - Paid In Full');
    }
  });
  it('ledger keys are unique', () => {
    expect(new Set(demo.lines.map((l) => l.key)).size).toBe(demo.lines.length);
  });
  it('twice-monthly runs end today or earlier, with paid → approved → draft ordering', () => {
    const runs = demoRuns(TODAY);
    expect(runs.every((r) => r.start <= TODAY)).toBe(true);
    const order = ['paid', 'approved', 'draft'];
    const idx = runs.map((r) => order.indexOf(r.status));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(runs.at(-1)?.status).toBe('draft');
  });
  it('assigns every rep to a team and makes leaders managers; one rep is inactive', () => {
    expect(demo.reps.every((r) => r.teamId)).toBe(true);
    for (const t of demo.teams) expect(demo.reps.find((r) => r.id === t.leaderRepId)?.role).toBe('manager');
    expect(demo.reps.filter((r) => !r.active).map((r) => r.name)).toEqual(['Levi Forgash']);
  });
});
