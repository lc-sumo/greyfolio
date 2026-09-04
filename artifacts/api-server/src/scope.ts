/**
 * Rep-scoped projections. Everything a rep's client receives is built here,
 * from the domain layer, and contains ONLY what a rep may see: funded amount,
 * their role(s), their rate(s), their share, payment status, their clawbacks.
 *
 * Never present in any rep payload: house net, referral partner or fee,
 * override amounts belonging to someone else, other reps' ids or names.
 * `assertRepSafe` is the guard tests run over every projection.
 */
import { RENEWAL_BUCKET_LABEL, cents, clawbackWindow, collectionLabel, dealCommissionStatus, dealPayback, disbursementOf, isLinePaid, linesInPeriod, monthlySeries, paidFigures, paidKeys, renewalOf, repClawback, repDeals, repLedger, repLines, repShare, segments, standingLines, sum, totalFunded, type Clawback, type ClawbackWindow, type CommissionStatus, type Deal, type LedgerContext, type Lender, type PayoutLine, type PayrollRun, type ProductRule, type RenewalBucket, type RenewalSettings, type Rep, type Role, unitsPaid, voidedKeys } from '@greystone/commission';

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
  /** `Initial` | `Draw 2` — one entry per role per segment the rep earns on. */
  segment: string;
  segmentKey: string;
  paid: boolean;
  paidAmount: number;
  /** Incremental segments: how many lender receipts have been paid to the rep, and how many the lender has paid. */
  units: { paid: number; total: number; collected: number } | null;
}

/** 'Awaiting lender': nothing is owed yet because the lender has not paid the commission this share sits on. */
export type PayoutStatus = 'Paid' | 'Partially paid' | 'Owed' | 'Awaiting lender';

export interface RepDealView {
  id: string;
  /** The CRM's deal ID; `id` is the sheet row (F-series). */
  crmId: string | null;
  date: string;
  business: string;
  lender: string;
  product: string;
  /** Total funded across every segment (initial + draws). */
  funded: number;
  /** For a consolidation funded in increments: what has gone out to the merchant against the plan. */
  disbursement: { planned: number; perIncrement: number; disbursed: number; final: number; count: number; total: number; stopped: boolean; uneven: boolean } | null;
  drawCount: number;
  roles: Role[];
  lines: RepRoleLine[];
  /** Σ of the rep's lines — their share of the deal. */
  share: number;
  /** Share on commission the lender has already paid. */
  accrued: number;
  paid: number;
  owed: number;
  payoutStatus: PayoutStatus;
  commissionStatus: CommissionStatus;
  lenderPaidLabel: string;
  dealStatus: string;
  repPaid: string | null;
  /** When this deal clears the lender's clawback window — the rep's commission is safe after that. */
  clawbackWindow: ClawbackWindow;
  clawback: { amount: number; remaining: number; status: Clawback['status'] } | null;
}

function payoutStatus(share: number, paid: number, accrued: number): PayoutStatus {
  if (share > 0 && paid >= share) return 'Paid';
  if (paid > 0) return 'Partially paid';
  return accrued > paid ? 'Owed' : 'Awaiting lender';
}

/** What the rep view needs from Settings to apply the lender's clawback policy. */
export type ClawbackSettings = { lenders: Lender[]; products: ProductRule[]; thresholds: { clawbackWindowDays: number }; today?: string };
const DEFAULT_CLAWBACK_SETTINGS: ClawbackSettings = { lenders: [], products: [], thresholds: { clawbackWindowDays: 30 } };

export function repDealView(deal: Deal, repId: string, lines: PayoutLine[], clawbacks: Clawback[] = [], settings: ClawbackSettings = DEFAULT_CLAWBACK_SETTINGS): RepDealView {
  const mine = repLines(deal, repId);
  const paidSet = paidKeys(lines.filter((l) => l.repId === repId));
  const share = repShare(deal, repId);
  const accrued = sum(mine.filter((l) => l.collected).map((l) => l.amount));
  const grouped = new Map<string, typeof mine>();
  for (const l of mine) grouped.set(`${l.role}|${l.segmentKey}`, [...(grouped.get(`${l.role}|${l.segmentKey}`) ?? []), l]);
  const paid = sum(standingLines(lines).filter((l) => l.repId === repId && l.dealId === deal.id && l.amount > 0).map((l) => l.amount));
  const segs = segments(deal);
  // Every clawback on the deal, summed — one banner, one remaining figure.
  const cbs = clawbacks.filter((c) => c.dealId === deal.id);
  const slices = cbs.map((c) => repClawback(c, deal, repId, lines));
  const cb = cbs.length ? { amount: sum(slices.map((x) => x.share)), remaining: sum(slices.map((x) => x.remaining)), status: cbs.some((c) => c.status === 'open') ? ('open' as const) : ('recovered' as const) } : null;
  return {
    id: deal.id,
    crmId: deal.crmId,
    date: deal.date,
    business: deal.business,
    lender: deal.lender,
    product: deal.product,
    funded: totalFunded(deal),
    disbursement: (() => { const b = segments(deal)[0]!; return disbursementOf(b.planned?.amount ?? b.amount, b.schedule); })(),
    drawCount: deal.draws.length,
    roles: [...new Set(mine.map((l) => l.role))],
    lines: [...grouped.values()].map((ls) => {
      const f = ls[0]!;
      const paidLs = ls.filter((l) => isLinePaid(l, paidSet));
      return {
        role: f.role,
        rate: f.rate,
        amount: sum(ls.map((l) => l.amount)),
        segment: f.segment.label,
        segmentKey: f.segmentKey,
        paid: paidLs.length === ls.length,
        paidAmount: sum(paidLs.map((l) => l.amount)),
        units: f.unit ? unitsPaid(deal, lines, repId, f.segmentKey) : null,
      };
    }),
    share,
    accrued,
    paid,
    owed: Math.max(0, cents(accrued - paid)),
    payoutStatus: payoutStatus(share, paid, accrued),
    commissionStatus: dealCommissionStatus(deal),
    lenderPaidLabel: segs.length === 1 ? collectionLabel(segs[0]!) : `${segs.filter((s) => collectionLabel(s) === 'Collected' || /^(\d+)\/\1 wks$/.test(collectionLabel(s))).length}/${segs.length} segments`,
    dealStatus: deal.dealStatus,
    repPaid: deal.repPaid,
    clawback: cb,
    clawbackWindow: clawbackWindow(deal, { lender: settings.lenders.find((l) => l.name === deal.lender), rule: settings.products.find((p) => p.name === deal.product), defaultDays: settings.thresholds.clawbackWindowDays }, settings.today ?? new Date().toISOString().slice(0, 10)),
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
  return { earned: l.earned, paid: l.paid, cash: l.cash, held: l.held, recovered: l.recovered, owed: l.owed, dealCount: l.deals.length, awaitingLender: l.awaitingLender };
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
  commission: number | null;
}

/** Top N by net commission, anonymized except the viewer, who is appended if outside the top N. */
export function leaderboard(ctx: LedgerContext, reps: Rep[], repId: string, limit = 6): LeaderboardRow[] {
  // Rank only: another rep's dollars never leave the server. The viewer sees their own figure and everyone's position.
  const ranked = reps
    .filter((r) => r.active || r.id === repId)
    .map((r) => ({ id: r.id, net: repLedger(ctx, r.id).earned }))
    .sort((a, b) => b.net - a.net || a.id.localeCompare(b.id))
    .map((r, i) => ({ rank: i + 1, label: r.id === repId ? 'You' : `Rep #${i + 1}`, isMe: r.id === repId, commission: r.id === repId ? r.net : null }));
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
    const f = paidFigures(rows, ctx.lines);
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

export function repDashboard(ctx: LedgerContext, reps: Rep[], runs: PayrollRun[], repId: string, from: string, to: string, cycle = 'Twice monthly', settings: ClawbackSettings = DEFAULT_CLAWBACK_SETTINGS): RepDashboard {
  const wallet = repWallet(ctx, repId);
  const mine = repDeals(ctx.deals, repId);
  const inPeriod = (d: Deal) => d.date >= from && d.date <= to;
  const periodDeals = mine.filter(inPeriod);
  const periodLines = ctx.lines.filter((l) => l.repId === repId && l.paidAt >= from && l.paidAt <= to);
  const f = paidFigures(periodLines, ctx.lines);
  const periodEarned = (id: string) => sum(repDeals(ctx.deals, id).filter(inPeriod).map((d) => repShare(d, id)));
  const ranked = reps
    .filter((r) => r.active || r.id === repId)
    .map((r) => ({ id: r.id, earned: periodEarned(r.id) }))
    .sort((a, b) => b.earned - a.earned || a.id.localeCompare(b.id));
  const rankIdx = ranked.findIndex((r) => r.id === repId);
  // Next payout: the first unpaid run whose period has not ended. None open yet → null (the UI says so) rather than a past date.
  const unpaid = [...runs].filter((r) => r.status !== 'paid' && !r.id.startsWith('import-')).sort((a, b) => a.end.localeCompare(b.end));
  const next = unpaid.find((r) => r.end >= to) ?? null;
  const owedToMe = mine
    .map((d) => repDealView(d, repId, ctx.lines, ctx.clawbacks, settings))
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
  crmId: string | null;
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
      // One rate per role: incremental deals carry one line per receipt, all at the same rate.
      const rate = sum([...new Map(mine.filter((l) => l.segmentKey === 'base').map((l) => [l.role, l.rate])).values()]);
      const whoCalls: RepRenewalView['whoCalls'] = d.closerId === repId ? 'You' : d.closerId ? 'Closer' : d.openerId === repId ? 'You' : 'Opener';
      return {
        id: d.id,
        crmId: d.crmId,
        business: d.business,
        merchantContact: d.merchantContact,
        merchantEmail: d.merchantEmail,
        merchantPhone: d.merchantPhone,
        lender: d.lender,
        product: d.product,
        date: d.date,
        funded: totalFunded(d),
        payback: dealPayback(d),
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
  /** This row was later reversed by a void. */
  voided: boolean;
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
  const gone = voidedKeys(ctx.lines);
  const rows: PayHistoryRow[] = ctx.lines
    .filter((l) => l.repId === repId)
    .map((l) => ({
      key: l.key,
      paidAt: l.paidAt,
      dealId: l.dealId,
      business: byDeal.get(l.dealId)?.business ?? l.dealId,
      role: l.role,
      segmentKey: l.segmentKey,
      segmentLabel: l.role === 'Void' ? 'Voided' : !l.segmentKey ? 'Clawback' : l.segmentKey === 'base' ? 'Initial' : `Draw ${l.segmentKey.slice(1)}`,
      voided: gone.has(l.key),
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
    const f = paidFigures(ctx.lines.filter((l) => l.repId === repId && l.paidAt === d.date), ctx.lines);
    d.grossPaid = f.gross;
    d.recovered = f.recovered;
    d.cash = f.cash;
  }
  const f = paidFigures(ctx.lines.filter((l) => l.repId === repId));
  return { rows, days, summary: { grossPaid: f.gross, recovered: f.recovered, cash: f.cash, payouts: days.length } };
}
