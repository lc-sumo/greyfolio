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
  renewalOf,
  RENEWAL_BUCKET_LABEL,
  repClawback,
  repDeals,
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
  type RenewalBucket,
  type RenewalSettings,
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

export interface RepDashboard {
  wallet: RepWallet;
  nextPayout: { date: string | null; runLabel: string | null; cycle: string };
  period: { from: string; to: string; earned: number; paid: number; recovered: number; owed: number; funded: number; dealCount: number; rank: number | null; repCount: number };
  /** Earned by funded month, paid by cleared month — two axes, labelled as such. */
  monthly: Array<{ month: string; earned: number; paid: number }>;
  leaderboard: LeaderboardRow[];
  owedToMe: RepDealView[];
}

function monthsEnding(to: string, count: number): string[] {
  const [y, m] = to.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export function repDashboard(ctx: LedgerContext, reps: Rep[], runs: PayrollRun[], repId: string, from: string, to: string, cycle = 'Twice monthly'): RepDashboard {
  const wallet = repWallet(ctx, repId);
  const mine = repDeals(ctx.deals, repId);
  const inPeriod = (d: Deal) => d.date >= from && d.date <= to;
  const periodDeals = mine.filter(inPeriod);
  const periodLines = ctx.lines.filter((l) => l.repId === repId && l.paidAt >= from && l.paidAt <= to);
  const f = paidFigures(periodLines);
  const periodEarned = (id: string) => sum(repDeals(ctx.deals, id).filter(inPeriod).map((d) => repShare(d, id)));
  const ranked = reps
    .filter((r) => r.active || r.id === repId)
    .map((r) => ({ id: r.id, earned: periodEarned(r.id) }))
    .sort((a, b) => b.earned - a.earned || a.id.localeCompare(b.id));
  const rankIdx = ranked.findIndex((r) => r.id === repId);
  // Next payout: the first unpaid run still open as of `to`; otherwise the most recent unpaid run (approved, paying soon).
  const unpaid = [...runs].filter((r) => r.status !== 'paid').sort((a, b) => a.end.localeCompare(b.end));
  const next = unpaid.find((r) => r.end >= to) ?? unpaid.at(-1) ?? null;
  const owedToMe = mine
    .map((d) => repDealView(d, repId, ctx.lines, ctx.clawbacks))
    .filter((v) => v.owed > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  return {
    wallet,
    nextPayout: { date: next?.end ?? null, runLabel: next?.label ?? null, cycle },
    period: {
      from,
      to,
      earned: sum(periodDeals.map((d) => repShare(d, repId))),
      paid: f.gross,
      recovered: f.recovered,
      owed: wallet.owed,
      funded: sum(periodDeals.map(totalFunded)),
      dealCount: periodDeals.length,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      repCount: ranked.length,
    },
    monthly: monthlySeries(ctx, repId, monthsEnding(to, 7)),
    leaderboard: leaderboard(ctx, reps, repId),
    owedToMe,
  };
}

/* ---------- renewals (rep-scoped) ---------- */

export interface RepRenewalView {
  id: string;
  business: string;
  /** The rep needs these to follow up — they are the merchant's, not another rep's. */
  merchantContact: string;
  merchantEmail: string;
  merchantPhone: string;
  lender: string;
  product: string;
  date: string;
  funded: number;
  payback: number | null;
  termDays: number | null;
  frequency: string;
  factor: number | null;
  /** Sheet's Parent Deal column: the parent's id for a separately keyed draw; own id when this deal is a LOC / consolidation parent. */
  parentId: string | null;
  isParent: boolean;
  drawCount: number;
  pctPaidIn: number;
  markDate: string | null;
  maturityDate: string | null;
  daysToMark: number | null;
  bucket: RenewalBucket;
  bucketLabel: string;
  soon: boolean;
  prospectingDate: string;
  daysToProspecting: number;
  effectiveStatus: string;
  roles: Role[];
  /** "You" when this rep is the closer; otherwise the role that calls it, never a name. */
  whoCalls: 'You' | 'Closer' | 'Opener';
  /** The rep's share if the merchant renews at the same size and rate. */
  estRenewalShare: number;
  dealStatus: string;
}

export function repRenewals(ctx: LedgerContext, repId: string, settings: RenewalSettings, today: string): RepRenewalView[] {
  return repDeals(ctx.deals, repId)
    .map((d) => {
      const r = renewalOf(d, settings, today);
      const mine = repLines(d, repId);
      const roles = [...new Set(mine.map((l) => l.role))];
      const rate = sum(mine.filter((l) => l.segmentKey === 'base').map((l) => l.rate));
      const whoCalls: RepRenewalView['whoCalls'] = d.closerId === repId ? 'You' : d.closerId ? 'Closer' : d.openerId === repId ? 'You' : 'Opener';
      return {
        id: d.id,
        business: d.business,
        merchantContact: d.merchantContact,
        merchantEmail: d.merchantEmail,
        merchantPhone: d.merchantPhone,
        lender: d.lender,
        product: d.product,
        date: d.date,
        funded: totalFunded(d),
        payback: d.payback,
        termDays: d.termDays,
        frequency: d.frequency,
        factor: d.factor,
        parentId: d.parentId,
        isParent: d.drawSubsequentPct !== null || d.draws.length > 0,
        drawCount: d.draws.length,
        pctPaidIn: r.pctPaidIn,
        markDate: r.markDate,
        maturityDate: r.maturityDate,
        daysToMark: r.daysToMark,
        bucket: r.bucket,
        bucketLabel: RENEWAL_BUCKET_LABEL[r.bucket],
        soon: r.soon,
        prospectingDate: r.prospectingDate,
        daysToProspecting: r.daysToProspecting,
        effectiveStatus: r.effectiveStatus,
        roles,
        whoCalls,
        estRenewalShare: sum([r.estRenewalGross * rate]),
        dealStatus: r.effectiveStatus,
      };
    })
    .sort((a, b) => order(a.bucket) - order(b.bucket) || (a.daysToMark ?? 9e9) - (b.daysToMark ?? 9e9));
}

function order(b: RenewalBucket): number {
  return { due: 0, prospecting: 1, building: 2, risk: 3, refinanced: 4 }[b];
}

/* ---------- pay history (rep-scoped) ---------- */

export interface PayHistoryRow {
  key: string;
  paidAt: string;
  dealId: string;
  business: string;
  role: string;
  segmentKey: string | null;
  segmentLabel: string;
  amount: number;
  runId: string | null;
  runLabel: string | null;
}

export interface PayHistory {
  rows: PayHistoryRow[];
  /** Grouped by payout date, newest first, each with gross / recovered / cash. */
  days: Array<{ date: string; runLabel: string | null; grossPaid: number; recovered: number; cash: number; rows: PayHistoryRow[] }>;
  summary: { grossPaid: number; recovered: number; cash: number; payouts: number };
}

/** Every ledger row for the rep: when they were paid, how much, and for which deal. */
export function repPayHistory(ctx: LedgerContext, runs: PayrollRun[], repId: string): PayHistory {
  const byDeal = new Map(ctx.deals.map((d) => [d.id, d]));
  const runLabel = new Map(runs.map((r) => [r.id, r.label]));
  const rows: PayHistoryRow[] = ctx.lines
    .filter((l) => l.repId === repId)
    .map((l) => ({
      key: l.key,
      paidAt: l.paidAt,
      dealId: l.dealId,
      business: byDeal.get(l.dealId)?.business ?? l.dealId,
      role: l.role,
      segmentKey: l.segmentKey,
      segmentLabel: !l.segmentKey ? 'Clawback' : l.segmentKey === 'base' ? 'Initial' : `Draw ${l.segmentKey.slice(1)}`,
      amount: l.amount,
      runId: l.runId,
      runLabel: l.runId ? runLabel.get(l.runId) ?? l.runId : null,
    }))
    .sort((a, b) => b.paidAt.localeCompare(a.paidAt) || (b.amount > 0 ? 1 : 0) - (a.amount > 0 ? 1 : 0) || a.dealId.localeCompare(b.dealId, undefined, { numeric: true }));
  const days: PayHistory['days'] = [];
  for (const r of rows) {
    let day = days.find((d) => d.date === r.paidAt);
    if (!day) days.push((day = { date: r.paidAt, runLabel: r.runLabel, grossPaid: 0, recovered: 0, cash: 0, rows: [] }));
    day.rows.push(r);
  }
  for (const d of days) {
    const f = paidFigures(ctx.lines.filter((l) => l.repId === repId && l.paidAt === d.date));
    d.grossPaid = f.gross;
    d.recovered = f.recovered;
    d.cash = f.cash;
  }
  const f = paidFigures(ctx.lines.filter((l) => l.repId === repId));
  return { rows, days, summary: { grossPaid: f.gross, recovered: f.recovered, cash: f.cash, payouts: days.length } };
}
