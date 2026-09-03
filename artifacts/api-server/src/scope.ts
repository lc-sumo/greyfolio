/**
 * Rep-scoped projections. Everything a rep's client receives is built here,
 * from the domain layer, and contains ONLY what a rep may see: funded amount,
 * their role(s), their rate(s), their share, payment status, their clawbacks.
 *
 * Never present in any rep payload: house net, referral partner or fee,
 * override amounts belonging to someone else, other reps' ids or names.
 * `assertRepSafe` is the guard tests run over every projection.
 */
import {
  collectionLabel,
  dealCommissionStatus,
  linesInPeriod,
  monthlySeries,
  paidFigures,
  repClawback,
  repLedger,
  repLines,
  repShare,
  segments,
  sum,
  totalFunded,
  type Clawback,
  type CommissionStatus,
  type Deal,
  type LedgerContext,
  type PayoutLine,
  type PayrollRun,
  type Rep,
  type Role,
} from '@greystone/commission';

/** Keys that must never appear anywhere in a rep-scoped payload. */
export const REP_FORBIDDEN_KEYS: readonly string[] = [
  'houseNet',
  'gross',
  'net',
  'referralPartner',
  'referralRate',
  'referralFee',
  'referralFeeRaw',
  'openerId',
  'closerId',
  'overrideId',
  'openerRate',
  'closerRate',
  'overrideRate',
  'totalRepPayout',
  'psfPct',
  'originationFee',
  'creditLine',
  'drawInitialPct',
  'drawSubsequentPct',
];

export function assertRepSafe(payload: unknown, path = '$'): void {
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertRepSafe(v, `${path}[${i}]`));
    return;
  }
  if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (REP_FORBIDDEN_KEYS.includes(k)) throw new Error(`Rep payload leaks "${k}" at ${path}.${k}`);
      assertRepSafe(v, `${path}.${k}`);
    }
  }
}

export interface RepRoleLine {
  role: Role;
  rate: number;
  amount: number;
  /** `Initial` | `Draw 2` — one entry per segment the rep earns on. */
  segment: string;
  segmentKey: string;
  paid: boolean;
}

export type PayoutStatus = 'Paid' | 'Partially paid' | 'Owed';

export interface RepDealView {
  id: string;
  date: string;
  business: string;
  lender: string;
  product: string;
  /** Total funded across every segment (initial + draws). */
  funded: number;
  drawCount: number;
  roles: Role[];
  lines: RepRoleLine[];
  /** Σ of the rep's lines — their share of the deal. */
  share: number;
  paid: number;
  owed: number;
  payoutStatus: PayoutStatus;
  commissionStatus: CommissionStatus;
  lenderPaidLabel: string;
  dealStatus: string;
  repPaid: string | null;
  clawback: { amount: number; remaining: number; status: Clawback['status'] } | null;
}

function payoutStatus(share: number, paid: number): PayoutStatus {
  if (share > 0 && paid >= share) return 'Paid';
  return paid > 0 ? 'Partially paid' : 'Owed';
}

export function repDealView(deal: Deal, repId: string, lines: PayoutLine[], clawbacks: Clawback[] = []): RepDealView {
  const mine = repLines(deal, repId);
  const paidKeys = new Set(lines.filter((l) => l.amount > 0 && l.repId === repId).map((l) => l.key));
  const share = repShare(deal, repId);
  const paid = sum(lines.filter((l) => l.repId === repId && l.dealId === deal.id && l.amount > 0).map((l) => l.amount));
  const segs = segments(deal);
  const cb = clawbacks.find((c) => c.dealId === deal.id);
  const slice = cb ? repClawback(cb, deal, repId, lines) : null;
  return {
    id: deal.id,
    date: deal.date,
    business: deal.business,
    lender: deal.lender,
    product: deal.product,
    funded: totalFunded(deal),
    drawCount: deal.draws.length,
    roles: [...new Set(mine.map((l) => l.role))],
    lines: mine.map((l) => ({ role: l.role, rate: l.rate, amount: l.amount, segment: l.segmentLabel, segmentKey: l.segmentKey, paid: paidKeys.has(l.key) })),
    share,
    paid,
    owed: Math.max(0, share - paid),
    payoutStatus: payoutStatus(share, paid),
    commissionStatus: dealCommissionStatus(deal),
    lenderPaidLabel: segs.length === 1 ? collectionLabel(segs[0]!) : `${segs.filter((s) => collectionLabel(s) === 'Collected' || /^(\d+)\/\1 wks$/.test(collectionLabel(s))).length}/${segs.length} segments`,
    dealStatus: deal.dealStatus,
    repPaid: deal.repPaid,
    clawback: cb && slice ? { amount: slice.share, remaining: slice.remaining, status: cb.status } : null,
  };
}

export interface RepWallet {
  earned: number;
  paid: number;
  cash: number;
  held: number;
  recovered: number;
  owed: number;
  dealCount: number;
  /** "Awaiting lender": the rep's share sitting on commission the lender has not paid yet. */
  awaitingLender: number;
}

export function repWallet(ctx: LedgerContext, repId: string): RepWallet {
  const l = repLedger(ctx, repId);
  let awaiting = 0;
  for (const d of l.deals) {
    for (const line of repLines(d, repId)) {
      const label = collectionLabel(line.segment);
      const collected = label === 'Collected' || /^(\d+)\/\1 wks$/.test(label);
      if (!collected) awaiting += line.amount;
    }
  }
  return { earned: l.earned, paid: l.paid, cash: l.cash, held: l.held, recovered: l.recovered, owed: l.owed, dealCount: l.deals.length, awaitingLender: sum([awaiting]) };
}

export interface RepClawbackView {
  id: string;
  dealId: string;
  date: string;
  business: string;
  /** Deal-level clawback (the rep may see the deal's clawback amount, not its net). */
  dealClawback: number;
  chargedToMe: number;
  recovered: number;
  remaining: number;
  reason: string;
  status: Clawback['status'];
}

export function repClawbackViews(ctx: LedgerContext, repId: string): RepClawbackView[] {
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const out: RepClawbackView[] = [];
  for (const c of ctx.clawbacks) {
    const deal = byId.get(c.dealId);
    if (!deal) continue;
    const slice = repClawback(c, deal, repId, ctx.lines);
    if (slice.share <= 0) continue;
    out.push({
      id: c.id,
      dealId: c.dealId,
      date: c.date,
      business: deal.business,
      dealClawback: c.amount,
      chargedToMe: slice.share,
      recovered: slice.recovered,
      remaining: slice.remaining,
      reason: c.reason,
      status: c.status,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface LeaderboardRow {
  rank: number;
  /** "You" for the viewer; every other rep is anonymized. */
  label: string;
  isMe: boolean;
  /** Net commission earned (the rep's share), the ranking key. */
  commission: number;
}

/** Top N by net commission, anonymized except the viewer, who is appended if outside the top N. */
export function leaderboard(ctx: LedgerContext, reps: Rep[], repId: string, limit = 6): LeaderboardRow[] {
  const ranked = reps
    .map((r) => ({ id: r.id, net: repLedger(ctx, r.id).earned }))
    .sort((a, b) => b.net - a.net || a.id.localeCompare(b.id))
    .map((r, i) => ({ rank: i + 1, label: r.id === repId ? 'You' : `Rep #${i + 1}`, isMe: r.id === repId, commission: r.net }));
  const top = ranked.slice(0, limit);
  const me = ranked.find((r) => r.isMe);
  if (me && !top.some((r) => r.isMe)) top.push(me);
  return top;
}

export interface RepStatement {
  runId: string;
  period: string;
  status: PayrollRun['status'];
  dealCount: number;
  /** The rep's gross payout in the period (positive rows only). */
  grossPaid: number;
  clawbacks: number;
  netPaid: number;
}

/** One card per payout period the rep actually had lines in. */
export function repStatements(ctx: LedgerContext, runs: PayrollRun[], repId: string): RepStatement[] {
  const out: RepStatement[] = [];
  for (const run of runs) {
    const rows = ctx.lines.filter((l) => l.repId === repId && (l.runId === run.id || (!l.runId && linesInPeriod([l], run.start, run.end).length > 0)));
    if (rows.length === 0) continue;
    const f = paidFigures(rows);
    out.push({ runId: run.id, period: run.label, status: run.status, dealCount: new Set(rows.filter((l) => l.amount > 0).map((l) => l.dealId)).size, grossPaid: f.gross, clawbacks: f.recovered, netPaid: f.cash });
  }
  return out;
}

export function repMonthly(ctx: LedgerContext, repId: string, months: string[]) {
  return monthlySeries(ctx, repId, months);
}
