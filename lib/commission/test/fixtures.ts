import { commissionFor } from '../src/commission.js';
import type { Clawback, Deal, DealDraw, LedgerContext, PayoutLine, Rep, Team, WeeklySchedule } from '../src/types.js';

export const TODAY = '2026-09-02';

export const reps: Rep[] = [
  { id: 'rep-01', name: 'Leor', email: 'leor@greystoneus.com', role: 'admin', teamId: 'team-a', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { id: 'rep-02', name: 'Raymond Amato', email: 'raymond.amato@greystoneus.com', role: 'manager', teamId: 'team-a', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { id: 'rep-05', name: 'Zach Sanders', email: 'zach.sanders@greystoneus.com', role: 'manager', teamId: 'team-a', openerRate: 0.4, closerRate: 0.4, overrideRate: 0.05, active: true },
  { id: 'rep-07', name: 'Julian Ribak', email: 'julian.ribak@greystoneus.com', role: 'rep', teamId: 'team-a', openerRate: 0.35, closerRate: 0.35, overrideRate: 0.025, active: true },
  { id: 'rep-15', name: 'Noah Levine', email: 'noah.levine@greystoneus.com', role: 'rep', teamId: 'team-a', openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: false },
];

export const teams: Team[] = [{ id: 'team-a', name: 'Team Amato', leaderRepId: 'rep-02', overrideRate: 0.05 }];

export interface DealSpec {
  id: string;
  date?: string;
  funded?: number;
  factor?: number | null;
  apr?: number | null;
  termDays?: number | null;
  product?: string;
  basis?: 'funded' | 'draw' | 'payback';
  lender?: string;
  commRate?: number;
  psfPct?: number;
  originationFee?: number;
  referralPartner?: string | null;
  referralRate?: number;
  referralCap?: number | null;
  openerId?: string | null;
  openerRate?: number;
  closerId?: string | null;
  closerRate?: number;
  overrideId?: string | null;
  overrideRate?: number;
  commCollected?: number | null;
  commSchedule?: WeeklySchedule | null;
  drawSubsequentPct?: number | null;
  draws?: DealDraw[];
  repPaid?: string | null;
  business?: string;
}

/** Build a deal whose stored gross/net were produced by `commissionFor`, like the API will. */
export function makeDeal(spec: DealSpec): Deal {
  const funded = spec.funded ?? 100_000;
  const commRate = spec.commRate ?? 0.1;
  const calc = commissionFor({
    amount: funded,
    basis: spec.basis ?? 'funded',
    factor: spec.factor ?? 1.3,
    apr: spec.apr ?? null,
    termDays: spec.termDays ?? 120,
    commissionRate: commRate,
    psfRate: spec.psfPct ?? 0,
    originationFee: spec.originationFee ?? 0,
    referralRate: spec.referralRate ?? 0,
    referralCap: spec.referralCap ?? null,
  });
  return {
    id: spec.id,
    opportunityId: spec.id,
    parentId: null,
    date: spec.date ?? '2026-07-10',
    business: spec.business ?? `${spec.id} Business`,
    merchantContact: 'Daniel Reyes',
    merchantEmail: `${spec.id.toLowerCase()}@merchant.test`,
    merchantPhone: '(201) 555-0100',
    lender: spec.lender ?? 'MBC',
    product: spec.product ?? 'MCA',
    funded,
    factor: spec.factor ?? 1.3,
    apr: spec.apr ?? null,
    termDays: spec.termDays ?? 120,
    frequency: 'Daily',
    payback: calc.payback,
    commRate,
    psfPct: spec.psfPct ?? 0,
    originationFee: spec.originationFee ?? 0,
    referralPartner: spec.referralPartner ?? null,
    referralRate: spec.referralRate ?? 0,
    gross: calc.gross,
    referralFee: calc.referralFee,
    net: calc.net,
    openerId: spec.openerId === undefined ? 'rep-07' : spec.openerId,
    openerRate: spec.openerRate ?? 0.35,
    closerId: spec.closerId === undefined ? 'rep-05' : spec.closerId,
    closerRate: spec.closerRate ?? 0.4,
    overrideId: spec.overrideId === undefined ? 'rep-02' : spec.overrideId,
    overrideRate: spec.overrideRate ?? 0.05,
    commCollected: spec.commCollected === undefined ? 0 : spec.commCollected,
    commSchedule: spec.commSchedule ?? null,
    creditLine: null,
    drawInitialPct: null,
    drawSubsequentPct: spec.drawSubsequentPct ?? null,
    dealStatus: 'Performing',
    repPaid: spec.repPaid ?? null,
    lenderPaid: null,
    crmId: null,
    draws: spec.draws ?? [],
  };
}

export function makeDraw(n: number, amount: number, rate: number, opts: Partial<DealDraw> = {}): DealDraw {
  const calc = commissionFor({ amount, basis: 'draw', commissionRate: rate });
  return {
    n,
    ref: `D${n}`,
    date: opts.date ?? '2026-08-01',
    amount,
    commRate: rate,
    gross: calc.gross,
    referralFee: calc.referralFee,
    net: calc.net,
    collected: opts.collected === undefined ? 0 : opts.collected,
    schedule: opts.schedule ?? null,
    ...opts,
  };
}

export function line(key: string, repId: string, amount: number, extra: Partial<PayoutLine> = {}): PayoutLine {
  const [dealId, role, sk] = key.split('|');
  return {
    key,
    dealId: dealId!,
    segmentKey: (sk as PayoutLine['segmentKey']) ?? 'base',
    role: role as PayoutLine['role'],
    repId,
    amount,
    runId: 'run-1',
    clawbackId: null,
    paidAt: '2026-08-20',
    ...extra,
  };
}

export function makeClawback(id: string, dealId: string, amount: number, extra: Partial<Clawback> = {}): Clawback {
  return { id, dealId, date: '2026-08-15', amount, recovered: 0, reason: 'Merchant defaulted inside 30 days', status: 'open', ...extra };
}

export function ctx(deals: Deal[], lines: PayoutLine[] = [], clawbacks: Clawback[] = []): LedgerContext {
  return { deals, lines, clawbacks };
}
