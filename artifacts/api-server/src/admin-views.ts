/** Admin projections: everything, including house net, referral and every rep's name. Never served to reps. */
import {
  atRisk,
  clawbackSlices,
  collectedGross,
  collectedOf,
  collectionLabel,
  crmUrl,
  dealCommissionStatus,
  dealLines,
  houseNet,
  outstandingGross,
  outstandingOf,
  paymentFor,
  effectiveDealStatus,
  renewalOf,
  RENEWAL_BUCKET_LABEL,
  scheduleEvents,
  scheduleParts,
  segmentStatus,
  segments,
  sum,
  totalFunded,
  totalGross,
  totalNet,
  totalRepPayout,
  type Clawback,
  type Deal,
  type LedgerContext,
  type Rep,
  type RenewalBucket,
  type Role,
  type ScheduleEvent,
  type Segment,
} from '@greystone/commission';
import type { Settings } from './repo.js';

export interface RoleView {
  role: Role;
  repId: string | null;
  name: string | null;
  rate: number;
  amount: number;
  paid: number;
}

export interface AdminDealRow {
  id: string;
  opportunityId: string;
  parentId: string | null;
  date: string;
  business: string;
  drawCount: number;
  merchantContact: string;
  merchantEmail: string;
  merchantPhone: string;
  lender: string;
  product: string;
  funded: number;
  factor: number | null;
  apr: number | null;
  termDays: number | null;
  frequency: string;
  payback: number | null;
  commRate: number;
  psfPct: number;
  originationFee: number;
  gross: number;
  referralPartner: string | null;
  referralRate: number;
  referralFee: number;
  net: number;
  roles: RoleView[];
  totalRepPayout: number;
  houseNet: number;
  collected: number;
  outstanding: number;
  lenderPaidLabel: string;
  commissionStatus: string;
  /** Effective: manual statuses as stored, otherwise Performing / Prospecting / Refi Ready from the dates. */
  dealStatus: string;
  storedDealStatus: string;
  atRisk: boolean;
  repPaid: string | null;
  lenderPaid: string | null;
  crmId: string | null;
  crmUrl: string;
  creditLine: number | null;
  drawSubsequentPct: number | null;
  hasClawback: boolean;
  /** Lender receipts expected before today that have not landed. */
  overdueReceipts: number;
  overdueAmount: number;
}

export function adminDealRow(deal: Deal, ctx: LedgerContext, reps: Rep[], settings: Settings, today: string): AdminDealRow {
  const name = (id: string | null) => (id ? reps.find((r) => r.id === id)?.name ?? id : null);
  const lines = dealLines(deal);
  const paidKeys = new Set(ctx.lines.filter((l) => l.amount > 0).map((l) => l.key));
  const roleView = (role: Role, repId: string | null, rate: number): RoleView => {
    const mine = lines.filter((l) => l.role === role);
    return { role, repId, name: name(repId), rate, amount: sum(mine.map((l) => l.amount)), paid: sum(mine.filter((l) => paidKeys.has(l.key)).map((l) => l.amount)) };
  };
  const segs = segments(deal);
  const full = segs.filter((s) => outstandingOf(s) === 0 && s.gross > 0).length;
  return {
    id: deal.id,
    opportunityId: deal.opportunityId,
    parentId: deal.parentId,
    date: deal.date,
    business: deal.business,
    drawCount: deal.draws.length,
    merchantContact: deal.merchantContact,
    merchantEmail: deal.merchantEmail,
    merchantPhone: deal.merchantPhone,
    lender: deal.lender,
    product: deal.product,
    funded: totalFunded(deal),
    factor: deal.factor,
    apr: deal.apr,
    termDays: deal.termDays,
    frequency: deal.frequency,
    payback: deal.payback,
    commRate: deal.commRate,
    psfPct: deal.psfPct,
    originationFee: deal.originationFee,
    gross: totalGross(deal),
    referralPartner: deal.referralPartner,
    referralRate: deal.referralRate,
    referralFee: sum(segs.map((s) => s.referralFee)),
    net: totalNet(deal),
    roles: [roleView('Opener', deal.openerId, deal.openerRate), roleView('Closer', deal.closerId, deal.closerRate), roleView('Override', deal.overrideId, deal.overrideRate)],
    totalRepPayout: totalRepPayout(deal),
    houseNet: houseNet(deal),
    collected: collectedGross(deal),
    outstanding: outstandingGross(deal),
    lenderPaidLabel: segs.length === 1 ? collectionLabel(segs[0]!) : `${full}/${segs.length} segments`,
    commissionStatus: dealCommissionStatus(deal),
    dealStatus: effectiveDealStatus(deal, settings.thresholds, today),
    storedDealStatus: deal.dealStatus,
    atRisk: atRisk(deal, settings.thresholds.clawbackWindowDays, today),
    repPaid: deal.repPaid,
    lenderPaid: deal.lenderPaid,
    crmId: deal.crmId,
    crmUrl: crmUrl(settings.crm.urlTemplate, deal),
    creditLine: deal.creditLine,
    drawSubsequentPct: deal.drawSubsequentPct,
    hasClawback: ctx.clawbacks.some((c) => c.dealId === deal.id),
    overdueReceipts: segs.reduce((n, s) => n + scheduleEvents(s, today).filter((e) => e.overdue).length, 0),
    overdueAmount: sum(segs.flatMap((s) => scheduleEvents(s, today).filter((e) => e.overdue).map((e) => e.amount))),
  };
}

export interface SegmentView {
  sk: string;
  label: string;
  n: number;
  date: string;
  amount: number;
  commRate: number;
  gross: number;
  referralFee: number;
  net: number;
  collected: number;
  outstanding: number;
  status: string;
  lenderPaidLabel: string;
  schedule: {
    weeks: number;
    received: number;
    startDate: string | null;
    perWeek: number;
    cadenceDays: number;
    upfrontPct: number;
    upfrontAmount: number;
    upfrontReceived: boolean;
    remainder: 'spread' | 'at-end';
    remainderAmount: number;
    remainderReceived: boolean;
    events: ScheduleEvent[];
    nextExpected: ScheduleEvent | null;
    overdue: number;
    overdueAmount: number;
  } | null;
  /** Funding terms: the deal's for the initial segment, the draw's own for draws. */
  termDays: number | null;
  factor: number | null;
  payback: number | null;
  payment: number | null;
}

export interface AdminDealDetail extends AdminDealRow {
  segments: SegmentView[];
  payments: Array<{ role: string; segmentKey: string | null; repId: string; repName: string; amount: number; paidAt: string; runId: string | null }>;
  clawbacks: Array<Clawback & { slices: Array<{ repId: string; name: string; share: number; recovered: number; remaining: number }> }>;
}

function termsOfDraw(deal: Deal, sk: string): { termDays: number | null; factor: number | null; payback: number | null; payment: number | null } {
  const x = deal.draws.find((d) => d.ref === sk);
  return { termDays: x?.termDays ?? null, factor: x?.factor ?? null, payback: x?.payback ?? null, payment: x?.payment ?? null };
}

export function adminDealDetail(deal: Deal, ctx: LedgerContext, reps: Rep[], settings: Settings, today: string): AdminDealDetail {
  const row = adminDealRow(deal, ctx, reps, settings, today);
  const name = (id: string) => reps.find((r) => r.id === id)?.name ?? id;
  return {
    ...row,
    segments: segments(deal).map((s) => ({
      sk: s.sk,
      label: s.label,
      n: s.n,
      date: s.date,
      amount: s.amount,
      commRate: s.commRate,
      gross: s.gross,
      referralFee: s.referralFee,
      net: s.net,
      collected: collectedOf(s),
      outstanding: outstandingOf(s),
      status: segmentStatus(s),
      lenderPaidLabel: collectionLabel(s),
      schedule: s.schedule ? scheduleView(s, today) : null,
      ...(s.sk === 'base'
        ? { termDays: deal.termDays, factor: deal.factor, payback: deal.payback, payment: paymentFor({ payback: deal.payback, termDays: deal.termDays, frequency: deal.frequency }) }
        : termsOfDraw(deal, s.sk)),
    })),
    payments: ctx.lines
      .filter((l) => l.dealId === deal.id)
      .map((l) => ({ role: l.role, segmentKey: l.segmentKey, repId: l.repId, repName: name(l.repId), amount: l.amount, paidAt: l.paidAt, runId: l.runId }))
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt)),
    clawbacks: ctx.clawbacks
      .filter((c) => c.dealId === deal.id)
      .map((c) => ({ ...c, slices: clawbackSlices(c, deal, ctx.lines).map((s) => ({ ...s, name: name(s.repId) })) })),
  };
}

function scheduleView(s: Segment, today: string): NonNullable<SegmentView['schedule']> {
  const sch = s.schedule!;
  const parts = scheduleParts(s.gross, sch);
  const events = scheduleEvents(s, today);
  const pending = events.filter((e) => !e.received && e.expected);
  return {
    weeks: sch.weeks,
    received: sch.received,
    startDate: sch.startDate,
    perWeek: parts.perIncrement,
    cadenceDays: sch.cadenceDays ?? 7,
    upfrontPct: sch.upfrontPct ?? 0,
    upfrontAmount: parts.upfront,
    upfrontReceived: !!sch.upfrontReceived,
    remainder: sch.remainder ?? 'spread',
    remainderAmount: parts.remainder,
    remainderReceived: !!sch.remainderReceived,
    events,
    nextExpected: pending.sort((a, b) => (a.expected! < b.expected! ? -1 : 1))[0] ?? null,
    overdue: events.filter((e) => e.overdue).length,
    overdueAmount: sum(events.filter((e) => e.overdue).map((e) => e.amount)),
  };
}

/* ---------- renewals (admin) ---------- */

const BUCKET_ORDER: Record<RenewalBucket, number> = { due: 0, prospecting: 1, building: 2, risk: 3, refinanced: 4 };

export interface AdminRenewalRow {
  id: string;
  crmId: string | null;
  business: string;
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
  /** Closer first name, else opener first name. */
  whoCalls: string;
  estRenewalGross: number;
  dealStatus: string;
  crmUrl: string;
}

export function adminRenewals(ctx: LedgerContext, reps: Rep[], settings: Settings, today: string): AdminRenewalRow[] {
  const first = (id: string | null) => (id ? (reps.find((r) => r.id === id)?.name ?? id).split(' ')[0]! : '—');
  return ctx.deals
    .map((d) => {
      const r = renewalOf(d, settings.thresholds, today);
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
        whoCalls: d.closerId ? first(d.closerId) : first(d.openerId),
        estRenewalGross: r.estRenewalGross,
        dealStatus: r.effectiveStatus,
        crmUrl: crmUrl(settings.crm.urlTemplate, d),
      };
    })
    .sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || (a.daysToMark ?? 9e9) - (b.daysToMark ?? 9e9));
}
