import { commissionFor, type Clawback, type Deal, type DealDraw, type LedgerContext, type PayoutLine, type PayrollRun, type Rep, type Team } from '@greystone/commission';
import type { AuditEntry, Repo } from '../src/repo.js';

export const reps: Rep[] = [
  { id: 'rep-leor', name: 'Leor', email: 'leor@greystoneus.com', role: 'admin', teamId: null, openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { id: 'rep-raymond-amato', name: 'Raymond Amato', email: 'raymond.amato@greystoneus.com', role: 'manager', teamId: 'team-a', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { id: 'rep-julian-ribak', name: 'Julian Ribak', email: 'julian.ribak@greystoneus.com', role: 'rep', teamId: 'team-a', openerRate: 0.35, closerRate: 0.35, overrideRate: 0.025, active: true },
  { id: 'rep-zach-sanders', name: 'Zach Sanders', email: 'zach.sanders@greystoneus.com', role: 'rep', teamId: 'team-b', openerRate: 0.4, closerRate: 0.4, overrideRate: 0.05, active: true },
  { id: 'rep-noah-levine', name: 'Noah Levine', email: 'noah.levine@greystoneus.com', role: 'rep', teamId: 'team-a', openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: false },
];

export const teams: Team[] = [
  { id: 'team-a', name: 'Team Amato', leaderRepId: 'rep-raymond-amato', overrideRate: 0.05 },
  { id: 'team-b', name: 'Team Sanders', leaderRepId: 'rep-zach-sanders', overrideRate: 0.05 },
];

export const runs: PayrollRun[] = [
  { id: 'run-4', label: 'Sep 1 – Sep 15, 2026', start: '2026-09-01', end: '2026-09-15', status: 'draft' },
  { id: 'run-3', label: 'Aug 16 – Aug 31, 2026', start: '2026-08-16', end: '2026-08-31', status: 'paid' },
];

function deal(id: string, opts: Partial<Deal> & { funded: number; commRate: number; referralRate?: number }): Deal {
  const calc = commissionFor({ amount: opts.funded, basis: 'funded', commissionRate: opts.commRate, referralRate: opts.referralRate ?? 0, referralCap: 15_000 });
  return {
    id,
    opportunityId: id,
    parentId: null,
    date: '2026-07-10',
    business: `${id} Business`,
    merchantContact: 'Daniel Reyes',
    merchantEmail: `${id.toLowerCase()}@merchant.test`,
    merchantPhone: '(201) 555-0100',
    lender: 'MBC',
    product: 'MCA',
    factor: 1.3,
    apr: null,
    termDays: 120,
    frequency: 'Daily',
    payback: calc.payback,
    psfPct: 0,
    originationFee: 0,
    referralPartner: opts.referralRate ? 'HUB TRACKER' : null,
    referralRate: opts.referralRate ?? 0,
    gross: calc.gross,
    referralFee: calc.referralFee,
    net: calc.net,
    openerId: 'rep-julian-ribak',
    openerRate: 0.35,
    closerId: 'rep-zach-sanders',
    closerRate: 0.4,
    overrideId: 'rep-raymond-amato',
    overrideRate: 0.05,
    commCollected: 0,
    commSchedule: null,
    creditLine: null,
    drawInitialPct: null,
    drawSubsequentPct: null,
    dealStatus: 'Performing',
    repPaid: null,
    lenderPaid: null,
    crmId: null,
    draws: [] as DealDraw[],
    ...opts,
  };
}

/** F1: net 1,000 (Julian 350 / Zach 400 / Raymond 50). F2: net 1,800 after MBC referral; Julian 630. F3: Zach only. */
export const deals: Deal[] = [
  deal('F1', { funded: 10_000, commRate: 0.1, commCollected: 1_000, date: '2026-06-05' }),
  deal('F2', { funded: 20_000, commRate: 0.1, referralRate: 0.1, date: '2026-07-12' }),
  deal('F3', { funded: 5_000, commRate: 0.1, openerId: 'rep-zach-sanders', closerId: 'rep-zach-sanders', overrideId: null, date: '2026-08-02' }),
];

export const lines: PayoutLine[] = [
  { key: 'F1|Opener|base', dealId: 'F1', segmentKey: 'base', role: 'Opener', repId: 'rep-julian-ribak', amount: 350, runId: 'run-3', clawbackId: null, paidAt: '2026-08-31' },
  { key: 'cbrec|cb-1|run-3|rep-julian-ribak', dealId: 'F1', segmentKey: null, role: 'Clawback recovery', repId: 'rep-julian-ribak', amount: -100, runId: 'run-3', clawbackId: 'cb-1', paidAt: '2026-08-31' },
];

export const clawbacks: Clawback[] = [{ id: 'cb-1', dealId: 'F1', date: '2026-08-15', amount: 1_000, recovered: 100, reason: 'Merchant defaulted inside 30 days', status: 'open' }];

export function memoryRepo(): Repo & { audit: AuditEntry[] } {
  const audit: AuditEntry[] = [];
  const ctx: LedgerContext = { deals, lines, clawbacks };
  return {
    audit,
    async findRepByEmail(email) {
      return reps.find((r) => r.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
    },
    async findRep(id) {
      return reps.find((r) => r.id === id) ?? null;
    },
    async listReps() {
      return reps;
    },
    async listTeams() {
      return teams;
    },
    async listRuns() {
      return runs;
    },
    async loadContext() {
      return ctx;
    },
    async writeAudit(e) {
      audit.push({ ...e, at: new Date().toISOString() });
    },
    async listAudit(limit = 100) {
      return audit.slice(-limit).reverse();
    },
  };
}
