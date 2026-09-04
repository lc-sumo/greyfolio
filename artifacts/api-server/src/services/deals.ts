import {
  ValidationError,
  asRate,
  collectedOf,
  newDraw,
  nextDealId,
  priceDeal,
  recordWeek,
  withStopped,
  withAmounts,
  scheduleFor,
  segmentOf,
  withCollection,
  withRemainder,
  withStatus,
  withUpfront,
  MANUAL_DEAL_STATUSES,
  type CommissionStatus,
  type Deal,
  type NewDealDraft,
  type SegmentKey,
} from '@greystone/commission';
import { clawbackRecovered, clawbackRepTotal, totalGross, type Clawback, type DealDraw } from '@greystone/commission';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';

const today = () => new Date().toISOString().slice(0, 10);

async function requireDeal(repo: Repo, id: string): Promise<Deal> {
  const ctx = await repo.loadContext();
  const deal = ctx.deals.find((d) => d.id === id);
  if (!deal) throw new HttpError(404, `Deal ${id} not found`);
  return deal;
}

function bad(e: unknown): never {
  if (e instanceof ValidationError) throw new HttpError(400, e.message);
  if (e instanceof Error && !(e instanceof HttpError)) throw new HttpError(400, e.message);
  throw e;
}

/** Only admins reach this (routes enforce it). Reps never create deals. */
/** Referral fees already owed to a partner on deals funded in the same month — what the monthly cap nets against. */
export function referralPaidInMonth(deals: Deal[], partner: string | null | undefined, fundedDate: string | null | undefined): number {
  if (!partner || partner === 'None' || !fundedDate) return 0;
  const month = fundedDate.slice(0, 7);
  return deals.filter((d) => d.referralPartner === partner && d.date.startsWith(month)).reduce((s, d) => s + d.referralFee, 0);
}

export async function createDeal(repo: Repo, draft: NewDealDraft, actorRepId: string): Promise<Deal> {
  const [settings, ctx, reps] = await Promise.all([repo.getSettings(), repo.loadContext(), repo.listReps()]);
  for (const [label, id] of [['Opener', draft.openerId], ['Closer', draft.closerId], ['Override', draft.overrideId]] as const) {
    if (id && !reps.some((r) => r.id === id)) throw new HttpError(400, `${label} rep ${id} does not exist`);
    if (id && !reps.find((r) => r.id === id)?.active) throw new HttpError(400, `${label} rep is inactive — new deals assign active reps only`);
  }
  if (draft.parentId && !ctx.deals.some((d) => d.id === draft.parentId)) throw new HttpError(400, `Parent deal ${draft.parentId} does not exist`);
  let deal: Deal;
  try {
    deal = priceDeal(draft, {
      id: nextDealId(ctx.deals.map((d) => d.id)),
      today: today(),
      rule: settings.products.find((p) => p.name === draft.product),
      lender: settings.lenders.find((l) => l.name === draft.lender),
      partner: settings.partners.find((p) => p.name === draft.referralPartner),
      referralPaidThisMonth: referralPaidInMonth(ctx.deals, draft.referralPartner, draft.fundedDate),
    });
  } catch (e) {
    bad(e);
  }
  await repo.insertDeal(deal);
  await repo.writeAudit({ actorRepId, action: 'deal.create', targetRepId: null, path: `/api/admin/deals/${deal.id}`, detail: { business: deal.business, funded: deal.funded } });
  return deal;
}

export interface SplitsInput {
  openerId?: string | null;
  openerRate?: number | null;
  closerId?: string | null;
  closerRate?: number | null;
  overrideId?: string | null;
  overrideRate?: number | null;
}

/** Editing an EXISTING deal may reference inactive reps — history must not move (invariant #9). */
/**
 * Correct a deal's core terms after entry. The deal is re-priced through the
 * same chain as creation; splits, collection progress, draws, status and CRM
 * fields carry over. Refused once anything for the deal is in the ledger —
 * void those payouts first, so "paid" never drifts from what was earned.
 */
export async function updateTerms(repo: Repo, id: string, input: Partial<NewDealDraft>, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, id);
  const [settings, ctx] = await Promise.all([repo.getSettings(), repo.loadContext()]);
  if (ctx.lines.some((l) => l.dealId === id)) throw new HttpError(400, `${id} has payouts in the ledger — void them before changing its terms`);
  const s = deal.commSchedule;
  const draft: NewDealDraft = {
    business: input.business ?? deal.business,
    merchantContact: input.merchantContact ?? deal.merchantContact,
    merchantEmail: input.merchantEmail ?? deal.merchantEmail,
    merchantPhone: input.merchantPhone ?? deal.merchantPhone,
    fundedDate: input.fundedDate ?? deal.date,
    lender: input.lender ?? deal.lender,
    product: input.product ?? deal.product,
    parentId: input.parentId === undefined ? deal.parentId : input.parentId,
    amount: input.amount ?? deal.funded,
    termDays: input.termDays === undefined ? deal.termDays : input.termDays,
    factor: input.factor === undefined ? deal.factor : input.factor,
    apr: input.apr === undefined ? deal.apr : input.apr,
    frequency: input.frequency ?? deal.frequency,
    commRate: input.commRate === undefined ? deal.commRate : input.commRate,
    psfPct: input.psfPct === undefined ? deal.psfPct : input.psfPct,
    originationFee: input.originationFee === undefined ? deal.originationFee : input.originationFee,
    referralPartner: input.referralPartner === undefined ? deal.referralPartner : input.referralPartner,
    creditLine: input.creditLine === undefined ? deal.creditLine : input.creditLine,
    lineRate: input.lineRate === undefined ? deal.lineRate ?? null : input.lineRate,
    drawInitialPct: input.drawInitialPct === undefined ? deal.drawInitialPct : input.drawInitialPct,
    drawSubsequentPct: input.drawSubsequentPct === undefined ? deal.drawSubsequentPct : input.drawSubsequentPct,
    openerId: deal.openerId, openerRate: deal.openerRate, closerId: deal.closerId, closerRate: deal.closerRate, overrideId: deal.overrideId, overrideRate: deal.overrideRate,
    commIncrements: input.commIncrements === undefined ? s?.weeks ?? null : input.commIncrements,
    commUpfrontPct: input.commUpfrontPct === undefined ? (s?.upfrontPct ?? null) : input.commUpfrontPct,
    commRemainder: input.commRemainder === undefined ? (s?.remainder ?? null) : input.commRemainder,
    commCadenceDays: input.commCadenceDays === undefined ? (s?.cadenceDays ?? null) : input.commCadenceDays,
    commStartDate: input.commStartDate === undefined ? (s?.startDate ?? null) : input.commStartDate,
    commAmounts: input.commAmounts === undefined ? (s?.amounts ?? null) : input.commAmounts,
  };
  if (draft.parentId && draft.parentId !== deal.parentId && !ctx.deals.some((d) => d.id === draft.parentId)) throw new HttpError(400, `Parent deal ${draft.parentId} does not exist`);
  let priced: Deal;
  try {
    priced = priceDeal(draft, {
      id,
      today: today(),
      rule: settings.products.find((p) => p.name === draft.product),
      lender: settings.lenders.find((l) => l.name === draft.lender),
      partner: settings.partners.find((p) => p.name === draft.referralPartner),
      referralPaidThisMonth: referralPaidInMonth(ctx.deals.filter((d) => d.id !== id), draft.referralPartner, draft.fundedDate),
    });
  } catch (e) {
    bad(e);
  }
  // Carry collection progress across the re-price.
  let commSchedule = priced.commSchedule;
  let commCollected = priced.commCollected;
  if (commSchedule && s) {
    commSchedule = { ...commSchedule, received: Math.min(s.received, commSchedule.weeks), upfrontReceived: commSchedule.upfrontPct ? !!s.upfrontReceived : undefined, remainderReceived: commSchedule.remainder === 'at-end' ? !!s.remainderReceived : undefined, stoppedAfter: s.stoppedAfter === null || s.stoppedAfter === undefined ? s.stoppedAfter : Math.min(s.stoppedAfter, commSchedule.weeks) };
  } else if (!commSchedule && typeof deal.commCollected === 'number') {
    commCollected = Math.min(deal.commCollected, priced.gross);
  }
  const { id: _id, draws: _draws, opportunityId: _opp, dealStatus: _st, repPaid: _rp, lenderPaid: _lp, crmId: _crm, ...pricedFields } = priced as Deal & { crmId?: string | null };
  const patch = { ...pricedFields, commSchedule, commCollected, parentId: draft.parentId || null, opportunityId: draft.parentId || id };
  await repo.updateDeal(id, patch);
  await repo.writeAudit({ actorRepId, action: 'deal.update', targetRepId: null, path: `/api/admin/deals/${id}/terms`, detail: { funded: priced.funded, lender: priced.lender, product: priced.product, date: priced.date, gross: priced.gross } });
  return requireDeal(repo, id);
}

/** Remove a mistyped deal. Refused once the ledger, a clawback or another deal (as parent) references it. */
export async function deleteDeal(repo: Repo, id: string, actorRepId: string): Promise<void> {
  const deal = await requireDeal(repo, id);
  const ctx = await repo.loadContext();
  if (ctx.lines.some((l) => l.dealId === id)) throw new HttpError(400, `${id} has payouts in the ledger — void them first`);
  if (ctx.clawbacks.some((c) => c.dealId === id)) throw new HttpError(400, `${id} has a clawback on record and cannot be deleted`);
  const children = ctx.deals.filter((d) => d.parentId === id);
  if (children.length) throw new HttpError(400, `${id} is the parent of ${children.map((d) => d.id).join(', ')} — re-parent or delete those first`);
  await repo.deleteDeal(id);
  await repo.writeAudit({ actorRepId, action: 'deal.delete', targetRepId: null, path: `/api/admin/deals/${id}`, detail: { business: deal.business, funded: deal.funded, lender: deal.lender, draws: deal.draws.map((d) => ({ ref: d.ref, amount: d.amount, date: d.date })) } });
}

export async function updateSplits(repo: Repo, id: string, input: SplitsInput, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, id);
  const reps = await repo.listReps();
  const pick = (v: string | null | undefined, current: string | null) => (v === undefined ? current : v || null);
  const patch = {
    openerId: pick(input.openerId, deal.openerId),
    closerId: pick(input.closerId, deal.closerId),
    overrideId: pick(input.overrideId, deal.overrideId),
    openerRate: input.openerRate === undefined ? deal.openerRate : asRate(input.openerRate),
    closerRate: input.closerRate === undefined ? deal.closerRate : asRate(input.closerRate),
    overrideRate: input.overrideRate === undefined ? deal.overrideRate : asRate(input.overrideRate),
  };
  for (const [label, rid] of [['Opener', patch.openerId], ['Closer', patch.closerId], ['Override', patch.overrideId]] as const) {
    if (rid && !reps.some((r) => r.id === rid)) throw new HttpError(400, `${label} rep ${rid} does not exist`);
  }
  if (!patch.openerId) patch.openerRate = 0;
  if (!patch.closerId) patch.closerRate = 0;
  if (!patch.overrideId) patch.overrideRate = 0;
  await repo.updateDeal(id, patch);
  await repo.writeAudit({ actorRepId, action: 'deal.update', targetRepId: null, path: `/api/admin/deals/${id}/splits`, detail: patch });
  return { ...deal, ...patch };
}

export async function setDealStatus(repo: Repo, id: string, dealStatus: string, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, id);
  const allowed = ['Performing', ...MANUAL_DEAL_STATUSES];
  if (!allowed.includes(dealStatus)) throw new HttpError(400, `Deal status must be one of: ${allowed.join(', ')}`);
  await repo.updateDeal(id, { dealStatus });
  await repo.writeAudit({ actorRepId, action: 'deal.update', targetRepId: null, path: `/api/admin/deals/${id}/status`, detail: { dealStatus } });
  return { ...deal, dealStatus };
}

export async function addDraw(repo: Repo, id: string, input: { amount: number; date?: string; termDays?: number | null; factor?: number | null }, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, id);
  const settings = await repo.getSettings();
  const date = input.date ?? today();
  if (date > today()) throw new HttpError(400, `Draw date ${date} is in the future`);
  const lender = settings.lenders.find((l) => l.name === deal.lender);
  const partner = settings.partners.find((p) => p.name === deal.referralPartner) ?? null;
  const incremental = !!settings.products.find((p) => p.name === deal.product)?.incremental;
  let draw;
  try {
    draw = newDraw(deal, {
      amount: Number(input.amount),
      date,
      partner,
      termDays: input.termDays ? Number(input.termDays) : null,
      factor: input.factor ? Number(input.factor) : null,
      // LOC draws are paid upfront; only an incremental (consolidation) product schedules its draws.
      schedule: incremental ? scheduleFor(lender, date) : null,
    });
  } catch (e) {
    bad(e);
  }
  await repo.insertDraw(id, draw);
  await repo.writeAudit({ actorRepId, action: 'deal.draw', targetRepId: null, path: `/api/admin/deals/${id}/draws`, detail: { ref: draw.ref, amount: draw.amount, net: draw.net } });
  return { ...deal, draws: [...deal.draws, draw] };
}

export type CollectionInput =
  | { segmentKey: SegmentKey; dollars: number }
  | { segmentKey: SegmentKey; status: CommissionStatus; partialDollars?: number }
  | { segmentKey: SegmentKey; recordWeeks: number }
  | { segmentKey: SegmentKey; toggle: true }
  | { segmentKey: SegmentKey; markUpfront: boolean }
  | { segmentKey: SegmentKey; markRemainder: boolean }
  | { segmentKey: SegmentKey; stopIncrements: boolean }
  | { segmentKey: SegmentKey; amounts: number[] | null };

/**
 * THE single collection writer. The status dropdown, the lender-paid pill,
 * "Record week received" and explicit dollar entry all land here, so
 * collection stays one quantity and status stays derived from it.
 */
export async function setCollection(repo: Repo, id: string, input: CollectionInput, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, id);
  const seg = segmentOf(deal, input.segmentKey);
  if (!seg) throw new HttpError(404, `Segment ${input.segmentKey} not found on ${id}`);
  let patch;
  if ('dollars' in input) patch = withCollection(seg, Number(input.dollars));
  else if ('status' in input) patch = withStatus(seg, input.status, input.partialDollars);
  else if ('recordWeeks' in input) {
    patch = recordWeek(seg, Number(input.recordWeeks));
    if (!patch) throw new HttpError(400, `${id} ${seg.sk} is not on an incremental schedule`);
  } else if ('markUpfront' in input) {
    patch = withUpfront(seg, !!input.markUpfront);
    if (!patch) throw new HttpError(400, `${id} ${seg.sk} has no upfront share`);
  } else if ('markRemainder' in input) {
    patch = withRemainder(seg, !!input.markRemainder);
    if (!patch) throw new HttpError(400, `${id} ${seg.sk} has no at-end remainder`);
  } else if ('amounts' in input) {
    try {
      patch = withAmounts(seg, Array.isArray(input.amounts) ? input.amounts.map(Number) : null);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'Bad increment grid');
    }
    if (!patch) throw new HttpError(400, `${id} ${seg.sk} is not funded in increments`);
  } else if ('stopIncrements' in input) {
    // Merchant opted out: the increments received so far are the increments there will be.
    patch = withStopped(seg, !!input.stopIncrements);
    if (!patch) throw new HttpError(400, `${id} ${seg.sk} is not funded in increments`);
  } else {
    const s = seg.schedule;
    if (s) patch = recordWeek(seg, s.received >= s.weeks ? -s.weeks : 1)!;
    else patch = withCollection(seg, collectedOf(seg) >= seg.gross ? 0 : seg.gross);
  }
  const collected = collectedOf({ ...seg, ...patch });
  if (seg.sk === 'base') {
    await repo.updateDeal(id, { commCollected: patch.collected, commSchedule: patch.schedule, lenderPaid: collected > 0 ? deal.lenderPaid ?? today() : null });
  } else {
    await repo.updateDraw(id, seg.sk, patch);
  }
  await repo.writeAudit({ actorRepId, action: 'deal.collection', targetRepId: null, path: `/api/admin/deals/${id}/collection`, detail: { segmentKey: seg.sk, collected } });
  return requireDeal(repo, id);
}

/** The CRM's deal ID (the F-number is only the sheet row). */
export async function setCrmId(repo: Repo, id: string, crmId: string | null, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, id);
  const value = crmId?.trim() || null;
  await repo.updateDeal(id, { crmId: value });
  await repo.writeAudit({ actorRepId, action: 'deal.update', targetRepId: null, path: `/api/admin/deals/${id}/crm`, detail: { crmId: value } });
  return { ...deal, crmId: value };
}

export interface ClawbackInput {
  amount: unknown;
  date?: unknown;
  reason?: unknown;
}

/**
 * Record a clawback against a deal. The dollar figure is the lender's
 * clawback on commission; each rep's slice follows from the domain rule in
 * `repClawback` and nets against their next payout, never twice.
 */
export async function recordClawback(repo: Repo, dealId: string, input: ClawbackInput, actorRepId: string): Promise<Clawback> {
  const deal = await requireDeal(repo, dealId);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Clawback amount must be more than zero');
  const gross = totalGross(deal);
  if (amount > gross + 0.005) throw new HttpError(400, `A clawback cannot exceed the deal's gross commission (${gross.toLocaleString('en-US', { style: 'currency', currency: 'USD' })})`);
  const ctxNow = await repo.loadContext();
  const already = ctxNow.clawbacks.filter((c) => c.dealId === dealId).reduce((t, c) => t + c.amount, 0);
  if (already + amount > gross + 0.005) throw new HttpError(400, `Clawbacks on ${dealId} already total ${already.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}; together they cannot exceed the deal's gross commission of ${gross.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`);
  const date = String(input.date ?? today()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Clawback date must be YYYY-MM-DD');
  if (date > today()) throw new HttpError(400, 'Clawback date cannot be in the future');
  if (date < deal.date) throw new HttpError(400, `Clawback date is before the deal funded (${deal.date})`);
  const ctx = await repo.loadContext();
  const n = ctx.clawbacks.filter((c) => c.dealId === dealId).length + 1;
  const clawback: Clawback = { id: `cb-${dealId}-${n}`, dealId, date, amount: Math.round(amount * 100) / 100, recovered: 0, reason: String(input.reason ?? '').trim().slice(0, 500), status: 'open' };
  await repo.insertClawback(clawback);
  await repo.writeAudit({ actorRepId, action: 'deal.clawback', targetRepId: null, path: `/api/admin/deals/${dealId}/clawbacks`, detail: { clawbackId: clawback.id, amount: clawback.amount, date } });
  return clawback;
}

/** Remove a draw that was entered by mistake. Refused once any ledger row (paid or voided) references it. */
export async function deleteDraw(repo: Repo, dealId: string, ref: string, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, dealId);
  const draw = deal.draws.find((d) => d.ref === ref);
  if (!draw) throw new HttpError(404, `Draw ${ref} not found on ${dealId}`);
  const ctx = await repo.loadContext();
  if (ctx.lines.some((l) => l.dealId === dealId && l.segmentKey === ref)) throw new HttpError(400, `${dealId} ${ref} has been paid on — void those payouts first, then remove the draw`);
  await repo.deleteDraw(dealId, ref);
  await repo.writeAudit({ actorRepId, action: 'deal.draw.delete', targetRepId: null, path: `/api/admin/deals/${dealId}/draws/${ref}`, detail: { ref, amount: draw.amount, date: draw.date } });
  return requireDeal(repo, dealId);
}

export interface ContactInput {
  business?: unknown;
  merchantContact?: unknown;
  merchantEmail?: unknown;
  merchantPhone?: unknown;
  /** Also update every other deal that shares the merchant's current email. */
  applyToMerchant?: unknown;
}

/**
 * Who the merchant is never changes the money, so it can be corrected on any
 * deal — paid or not. With `applyToMerchant`, every deal on the same email
 * moves together so the merchant does not split into two.
 */
export async function updateContact(repo: Repo, id: string, input: ContactInput, actorRepId: string): Promise<{ deal: Deal; updated: number }> {
  const deal = await requireDeal(repo, id);
  const str = (v: unknown, cur: string) => (v === undefined ? cur : String(v ?? '').trim());
  const patch = {
    business: str(input.business, deal.business),
    merchantContact: str(input.merchantContact, deal.merchantContact),
    merchantEmail: str(input.merchantEmail, deal.merchantEmail).toLowerCase(),
    merchantPhone: str(input.merchantPhone, deal.merchantPhone),
  };
  if (!patch.business) throw new HttpError(400, 'Business name is required');
  if (patch.merchantEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.merchantEmail)) throw new HttpError(400, 'That merchant email does not look right');
  const targets = input.applyToMerchant && deal.merchantEmail ? (await repo.loadContext()).deals.filter((d) => d.merchantEmail.toLowerCase() === deal.merchantEmail.toLowerCase()) : [deal];
  for (const t of targets) {
    // Business name follows only the deal being edited unless the merchant-wide switch is on.
    await repo.updateDeal(t.id, t.id === id || input.applyToMerchant ? patch : { merchantContact: patch.merchantContact, merchantEmail: patch.merchantEmail, merchantPhone: patch.merchantPhone });
  }
  await repo.writeAudit({ actorRepId, action: 'deal.contact', targetRepId: null, path: `/api/admin/deals/${id}/contact`, detail: { ...patch, deals: targets.map((t) => t.id) } });
  return { deal: await requireDeal(repo, id), updated: targets.length };
}

export interface DrawTermsInput {
  amount?: unknown;
  date?: unknown;
  termDays?: unknown;
  factor?: unknown;
  commRate?: unknown;
}

/** Correct a draw's amount, date, term, factor or rate. It re-prices; refused once anything was paid on that draw. */
export async function updateDrawTerms(repo: Repo, dealId: string, ref: string, input: DrawTermsInput, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, dealId);
  const draw = deal.draws.find((d) => d.ref === ref);
  if (!draw) throw new HttpError(404, `Draw ${ref} not found on ${dealId}`);
  const ctx = await repo.loadContext();
  if (ctx.lines.some((l) => l.dealId === dealId && l.segmentKey === ref)) throw new HttpError(400, `${dealId} ${ref} has been paid on — void those payouts first, then edit the draw`);
  const numOr = (v: unknown, cur: number | null | undefined) => (v === undefined ? cur ?? null : v === null || v === '' ? null : Number(v));
  const amount = numOr(input.amount, draw.amount);
  if (!(amount && amount > 0)) throw new HttpError(400, 'Draw amount must be more than zero');
  const date = input.date === undefined ? draw.date : String(input.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Draw date must be YYYY-MM-DD');
  const rateIn = numOr(input.commRate, draw.commRate);
  const commRate = rateIn === null ? draw.commRate : rateIn > 1 ? rateIn / 100 : rateIn;
  const settings = await repo.getSettings();
  const partner = deal.referralPartner ? settings.partners.find((p) => p.name === deal.referralPartner) ?? null : null;
  const others = deal.draws.filter((d) => d.ref !== ref);
  const repriced = newDraw({ ...deal, draws: others.slice(0, draw.n - 1) }, {
    amount,
    date,
    commRate,
    partner,
    termDays: numOr(input.termDays, draw.termDays),
    factor: numOr(input.factor, draw.factor),
    schedule: draw.schedule ? { mode: 'weekly', weeks: draw.schedule.weeks, received: 0, startDate: date } : null,
    frequency: deal.frequency,
    referralPaidThisMonth: referralPaidInMonth(ctx.deals.filter((d) => d.id !== dealId), deal.referralPartner, date),
  });
  const next: DealDraw = { ...repriced, n: draw.n, ref: draw.ref, collected: draw.schedule ? null : Math.min(draw.collected ?? 0, repriced.gross), schedule: draw.schedule ? { ...draw.schedule, startDate: date } : null };
  await repo.replaceDraw(dealId, ref, next);
  await repo.writeAudit({ actorRepId, action: 'deal.draw.update', targetRepId: null, path: `/api/admin/deals/${dealId}/draws/${ref}`, detail: { amount: next.amount, date: next.date, commRate: next.commRate, gross: next.gross } });
  return requireDeal(repo, dealId);
}

/** Correct a clawback. The amount can only drop as far as what reps have already repaid on it. */
export async function updateClawback(repo: Repo, dealId: string, clawbackId: string, input: { amount?: unknown; date?: unknown; reason?: unknown }, actorRepId: string): Promise<Clawback> {
  const deal = await requireDeal(repo, dealId);
  const ctx = await repo.loadContext();
  const cb = ctx.clawbacks.find((c) => c.id === clawbackId && c.dealId === dealId);
  if (!cb) throw new HttpError(404, 'Clawback not found');
  const patch: Partial<Pick<Clawback, 'amount' | 'date' | 'reason'>> = {};
  if (input.amount !== undefined) {
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!(amount > 0)) throw new HttpError(400, 'Clawback amount must be more than zero');
    if (amount > totalGross(deal) + 0.005) throw new HttpError(400, "A clawback cannot exceed the deal's gross commission");
    const recovered = clawbackRecovered(ctx.lines, cb.id);
    const repTotalAfter = clawbackRepTotal({ ...cb, amount }, deal);
    if (recovered > repTotalAfter + 0.005) throw new HttpError(400, `Reps have already repaid ${recovered.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} on this clawback — void those recoveries before lowering it that far`);
    patch.amount = amount;
  }
  if (input.date !== undefined) {
    const date = String(input.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today() || date < deal.date) throw new HttpError(400, 'Clawback date must be between the funded date and today');
    patch.date = date;
  }
  if (input.reason !== undefined) patch.reason = String(input.reason ?? '').trim().slice(0, 500);
  await repo.updateClawback(cb.id, patch);
  await repo.writeAudit({ actorRepId, action: 'deal.clawback.update', targetRepId: null, path: `/api/admin/deals/${dealId}/clawbacks/${cb.id}`, detail: patch });
  return { ...cb, ...patch };
}

/** Forgive / remove a clawback recorded in error. Refused once any rep has repaid on it — void those recoveries first. */
export async function deleteClawback(repo: Repo, dealId: string, clawbackId: string, actorRepId: string): Promise<void> {
  await requireDeal(repo, dealId);
  const ctx = await repo.loadContext();
  const cb = ctx.clawbacks.find((c) => c.id === clawbackId && c.dealId === dealId);
  if (!cb) throw new HttpError(404, 'Clawback not found');
  if (ctx.lines.some((l) => l.clawbackId === cb.id && l.role === 'Clawback recovery')) throw new HttpError(400, 'Reps have repaid on this clawback — void those recovery rows in payroll first');
  await repo.deleteClawback(cb.id);
  await repo.writeAudit({ actorRepId, action: 'deal.clawback.delete', targetRepId: null, path: `/api/admin/deals/${dealId}/clawbacks/${cb.id}`, detail: { amount: cb.amount, date: cb.date } });
}
