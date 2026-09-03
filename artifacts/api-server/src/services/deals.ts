import {
  ValidationError,
  asRate,
  collectedOf,
  newDraw,
  nextDealId,
  priceDeal,
  recordWeek,
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
  let draw;
  try {
    draw = newDraw(deal, {
      amount: Number(input.amount),
      date,
      partner,
      termDays: input.termDays ? Number(input.termDays) : null,
      factor: input.factor ? Number(input.factor) : null,
      schedule: lender?.terms === 'weekly' ? { mode: 'weekly', weeks: lender.weeks, received: 0, startDate: date } : null,
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
  | { segmentKey: SegmentKey; markRemainder: boolean };

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
