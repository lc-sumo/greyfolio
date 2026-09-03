/**
 * Row → domain mappers. The domain layer never sees Drizzle rows; the API
 * loads rows, maps them here, and hands a `LedgerContext` to
 * `@greystone/commission`.
 */
import type { Clawback, Deal, DealDraw, PayoutLine, Rep, SegmentKey, Team } from '@greystone/commission';
import type { ClawbackRow, DealDrawRow, DealRow, PayoutLineRow, RepRow, TeamRow } from './schema/commission.js';

export function toRep(r: RepRow): Rep {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role as Rep['role'],
    teamId: r.teamId,
    openerRate: r.openerRate,
    closerRate: r.closerRate,
    overrideRate: r.overrideRate,
    active: r.active,
  };
}

export function toTeam(t: TeamRow): Team {
  return { id: t.id, name: t.name, leaderRepId: t.leaderRepId, overrideRate: t.overrideRate };
}

export function toDraw(d: DealDrawRow): DealDraw {
  return {
    n: d.n,
    ref: d.ref as SegmentKey,
    date: d.date,
    amount: d.amount,
    commRate: d.commRate,
    gross: d.gross,
    referralFee: d.referralFee,
    net: d.net,
    collected: d.collected,
    schedule: d.schedule ?? null,
    termDays: d.termDays,
    factor: d.factor,
    payback: d.payback,
    payment: d.payment,
  };
}

export function toDeal(d: DealRow, draws: DealDrawRow[] = []): Deal {
  return {
    id: d.id,
    opportunityId: d.opportunityId,
    parentId: d.parentId,
    date: d.date,
    business: d.business,
    merchantContact: d.merchantContact,
    merchantEmail: d.merchantEmail,
    merchantPhone: d.merchantPhone,
    lender: d.lender,
    product: d.product,
    funded: d.funded,
    factor: d.factor,
    apr: d.apr,
    termDays: d.termDays,
    frequency: d.frequency,
    payback: d.payback,
    commRate: d.commRate,
    psfPct: d.psfPct,
    originationFee: d.originationFee,
    referralPartner: d.referralPartner,
    referralRate: d.referralRate,
    gross: d.gross,
    referralFee: d.referralFee,
    net: d.net,
    openerId: d.openerId,
    openerRate: d.openerRate,
    closerId: d.closerId,
    closerRate: d.closerRate,
    overrideId: d.overrideId,
    overrideRate: d.overrideRate,
    commCollected: d.commCollected,
    commSchedule: d.commSchedule ?? null,
    creditLine: d.creditLine,
    drawInitialPct: d.drawInitialPct,
    drawSubsequentPct: d.drawSubsequentPct,
    dealStatus: d.dealStatus,
    repPaid: d.repPaid,
    lenderPaid: d.lenderPaid,
    crmId: d.crmId,
    draws: draws.filter((x) => x.dealId === d.id).sort((a, b) => a.n - b.n).map(toDraw),
  };
}

export function toPayoutLine(l: PayoutLineRow): PayoutLine {
  return {
    key: l.key,
    dealId: l.dealId,
    segmentKey: (l.segmentKey as SegmentKey | null) ?? null,
    role: l.role as PayoutLine['role'],
    repId: l.repId,
    amount: l.amount,
    runId: l.runId,
    clawbackId: l.clawbackId,
    paidAt: l.paidAt,
  };
}

export function toClawback(c: ClawbackRow): Clawback {
  return { id: c.id, dealId: c.dealId, date: c.date, amount: c.amount, recovered: c.recovered, reason: c.reason, status: c.status as Clawback['status'] };
}
