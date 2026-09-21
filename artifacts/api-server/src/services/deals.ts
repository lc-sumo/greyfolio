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
  standingLines,
  withCollection,
  withRemainder,
  withStatus,
  withUpfront,
  MANUAL_DEAL_STATUSES,
  type CommissionStatus,
  type Deal,
  type NewDealDraft,
  type ProductRule,
  type SegmentKey,
  isConsolidationParentProduct,
  lenderSupportsProduct,
} from '@greystone/commission';
import { clawbackRecovered, clawbackRecoveryExcesses, clawbackRepTotal, lenderClawbackBase, type Clawback, type DealDraw, type PayoutLine } from '@greystone/commission';
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

/** Portal/API consolidation entries must carry their deal-specific funding grid.
 * Importers can continue calling priceDeal directly without a grid for legacy data. */
function requireConsolidationGrid(draft: NewDealDraft, rule?: ProductRule): NewDealDraft {
  const incremental = isConsolidationParentProduct(rule ?? draft.product);
  if (!incremental) return draft;
  const amounts = draft.commAmounts;
  if (!Array.isArray(amounts) || amounts.length === 0) {
    throw new HttpError(400, 'Consolidation increment breakdown is required; enter one positive amount per increment');
  }
  if (amounts.some((a) => !Number.isFinite(a) || Math.abs(a * 100 - Math.round(a * 100)) > 1e-7 || a <= 0)) {
    throw new HttpError(400, 'Every consolidation increment amount must be finite, use exact cents, and be greater than zero');
  }
  const total = amounts.reduce((sum, a) => sum + Math.round(a * 100), 0);
  const funded = Math.round(draft.amount * 100);
  if (total !== funded) {
    throw new HttpError(400, `Consolidation increment grid totals ${(total / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}; it must equal the funded amount ${(funded / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`);
  }
  return { ...draft, commAmounts: amounts, commIncrements: amounts.length };
}

function guardRecoveredAttribution(clawback: Clawback, proposedDeal: Deal, lines: PayoutLine[]): void {
  const recovered = clawbackRecovered(lines, clawback.id);
  const repTotalAfter = clawbackRepTotal(clawback, proposedDeal);
  const excess = clawbackRecoveryExcesses(clawback, proposedDeal, lines)[0];
  if (excess) throw new HttpError(400, `${excess.repId} has already repaid ${excess.recovered.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}, above their proposed ${excess.share.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} share — void excess recovery first`);
  if (recovered > repTotalAfter) throw new HttpError(400, `Reps have already repaid ${recovered.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} on this clawback — void those recoveries before changing its economics`);
}

function guardDealClawbacks(proposedDeal: Deal, lines: PayoutLine[], clawbacks: Clawback[]): void {
  const active = clawbacks.filter((clawback) => !clawback.forgivenAt);
  for (const clawback of active) guardRecoveredAttribution(clawback, proposedDeal, lines);
  const total = active.reduce((sum, clawback) => sum + clawback.amount, 0);
  const lenderBase = lenderClawbackBase(proposedDeal);
  if (total > lenderBase + 0.005) {
    throw new HttpError(400, `Active clawbacks total ${total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}; together they cannot exceed the lender-paid commission basis of ${lenderBase.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} (merchant PSF excluded)`);
  }
}

function proposedSegmentDeal(current: Deal, segmentKey: SegmentKey, patch: { collected: number | null; schedule: Deal['commSchedule'] }): Deal {
  return segmentKey === 'base'
    ? { ...current, commCollected: patch.collected, commSchedule: patch.schedule }
    : { ...current, draws: current.draws.map((draw) => draw.ref === segmentKey ? { ...draw, ...patch } : draw) };
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
  const configuredRule = settings.products.find((p) => p.name === draft.product);
  const configuredLender = settings.lenders.find((l) => l.name === draft.lender);
  if (!configuredRule) throw new HttpError(400, `Unknown product "${draft.product}"`);
  if (!configuredLender) throw new HttpError(400, `Unknown lender "${draft.lender}"`);
  if (!lenderSupportsProduct(configuredLender, configuredRule)) throw new HttpError(400, `Lender "${draft.lender}" is not configured for product "${draft.product}"`);
  draft = requireConsolidationGrid(draft, configuredRule);
  for (const [label, id] of [['Opener', draft.openerId], ['Closer', draft.closerId], ['Override', draft.overrideId]] as const) {
    if (id && !reps.some((r) => r.id === id)) throw new HttpError(400, `${label} rep ${id} does not exist`);
    const rep = id ? reps.find((r) => r.id === id) : null;
    if (id && !rep?.active) throw new HttpError(400, `${label} rep is inactive — new deals assign active reps only`);
    if (id && rep?.commissionEligible === false) throw new HttpError(400, `${label} user is not commission-eligible and cannot be assigned to a new deal`);
  }
  if (draft.parentId && !ctx.deals.some((d) => d.id === draft.parentId)) throw new HttpError(400, `Parent deal ${draft.parentId} does not exist`);
  const renewed = draft.renewedFromId ? ctx.deals.find((d) => d.id === draft.renewedFromId) : undefined;
  if (draft.renewedFromId && !renewed) throw new HttpError(400, `Renewed deal ${draft.renewedFromId} does not exist`);
  let deal: Deal;
  try {
    deal = priceDeal(draft, {
      id: nextDealId(ctx.deals.map((d) => d.id)),
      today: today(),
      rule: (() => {
         const configured = settings.products.find((p) => p.name === draft.product);
         return isConsolidationParentProduct(configured) && configured ? { ...configured, incremental: true, multiDraw: false, drawInitial: null, drawSubsequent: null } : configured;
       })(),
      lender: settings.lenders.find((l) => l.name === draft.lender),
      partner: settings.partners.find((p) => p.name === draft.referralPartner),
      referralPaidThisMonth: referralPaidInMonth(ctx.deals, draft.referralPartner, draft.fundedDate),
    });
  } catch (e) {
    bad(e);
  }
  await repo.insertDeal(deal);
  // A renewal closes the deal it replaces, unless ops already gave that one a final status.
  if (renewed && !['Refinanced', 'Paid In Full', 'Default'].includes(renewed.dealStatus)) await repo.updateDeal(renewed.id, { dealStatus: 'Refinanced' });
  await repo.writeAudit({ actorRepId, action: 'deal.create', targetRepId: null, path: `/api/admin/deals/${deal.id}`, detail: { business: deal.business, funded: deal.funded, ...(renewed ? { renewedFrom: renewed.id } : {}) } });
  return deal;
}

/** Link (or unlink, with null) the deal this one renewed. Marks the earlier deal Refinanced when it is still live. */
export async function linkRenewal(repo: Repo, id: string, fromId: unknown, actorRepId: string): Promise<{ renewedFromId: string | null }> {
  const deal = await requireDeal(repo, id);
  const from = fromId === null || fromId === undefined || fromId === '' ? null : String(fromId);
  if (from === id) throw new HttpError(400, 'A deal cannot renew itself');
  const ctx = await repo.loadContext();
  const prev = from ? ctx.deals.find((d) => d.id === from) : null;
  if (from && !prev) throw new HttpError(404, `Deal ${from} not found`);
  if (prev && prev.date > deal.date) throw new HttpError(400, `${prev.id} funded after ${deal.id} — the renewal comes second`);
  await repo.updateDeal(id, { renewedFromId: from });
  if (prev && !['Refinanced', 'Paid In Full', 'Default'].includes(prev.dealStatus)) await repo.updateDeal(prev.id, { dealStatus: 'Refinanced' });
  await repo.writeAudit({ actorRepId, action: 'deal.update', targetRepId: null, path: `/api/admin/deals/${id}/renewal`, detail: { renewedFromId: from } });
  return { renewedFromId: from };
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
  const selectedProduct = settings.products.find((p) => p.name === (input.product ?? deal.product));
  const selectedLender = settings.lenders.find((l) => l.name === (input.lender ?? deal.lender));
  if (!selectedProduct) throw new HttpError(400, `Unknown product "${input.product ?? deal.product}"`);
  if (!selectedLender) throw new HttpError(400, `Unknown lender "${input.lender ?? deal.lender}"`);
  if (!lenderSupportsProduct(selectedLender, selectedProduct)) throw new HttpError(400, `Lender "${selectedLender.name}" is not configured for product "${selectedProduct.name}"`);
  if (ctx.lines.some((l) => l.dealId === id)) throw new HttpError(400, `${id} has payouts in the ledger — void them before changing its terms`);
  const s = deal.commSchedule;
  let draft: NewDealDraft = {
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
    leadSource: input.leadSource === undefined ? deal.leadSource ?? null : input.leadSource,
    notes: input.notes === undefined ? deal.notes ?? null : input.notes,
  };
  draft = requireConsolidationGrid(draft, selectedProduct);
  if (draft.parentId && draft.parentId !== deal.parentId && !ctx.deals.some((d) => d.id === draft.parentId)) throw new HttpError(400, `Parent deal ${draft.parentId} does not exist`);
  let priced: Deal;
  try {
    priced = priceDeal(draft, {
      id,
      today: today(),
      rule: (() => {
         const configured = settings.products.find((p) => p.name === draft.product);
         return isConsolidationParentProduct(configured) && configured ? { ...configured, incremental: true, multiDraw: false, drawInitial: null, drawSubsequent: null } : configured;
       })(),
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
  const receivedActivity = !!s && (s.received > 0 || !!s.upfrontReceived || !!s.remainderReceived);
  if (s && receivedActivity && !commSchedule) {
    throw new HttpError(400, 'The incremental schedule has received commission history and cannot be removed');
  }
  if (commSchedule && s) {
    if (commSchedule.weeks < s.received) throw new HttpError(400, `The grid has ${commSchedule.weeks} increments but ${s.received} were already received`);
    const oldAmounts = s.amounts ?? (s.weeks > 0 ? Array.from({ length: s.weeks }, () => Math.round((deal.funded / s.weeks) * 100) / 100) : []);
    const nextAmounts = commSchedule.amounts ?? [];
    for (let i = 0; i < s.received; i++) {
      if (Math.round((oldAmounts[i] ?? 0) * 100) !== Math.round((nextAmounts[i] ?? 0) * 100)) {
        throw new HttpError(400, `Received increment ${i + 1} is immutable`);
      }
    }
    commSchedule = { ...commSchedule, received: Math.min(s.received, commSchedule.weeks), upfrontReceived: commSchedule.upfrontPct ? !!s.upfrontReceived : undefined, remainderReceived: commSchedule.remainder === 'at-end' ? !!s.remainderReceived : undefined, stoppedAfter: s.stoppedAfter === null || s.stoppedAfter === undefined ? s.stoppedAfter : Math.min(s.stoppedAfter, commSchedule.weeks) };
  } else if (!commSchedule && typeof deal.commCollected === 'number') {
    commCollected = Math.min(deal.commCollected, priced.gross);
  }
  const { id: _id, draws: _draws, opportunityId: _opp, dealStatus: _st, repPaid: _rp, lenderPaid: _lp, crmId: _crm, ...pricedFields } = priced as Deal & { crmId?: string | null };
  const patch = { ...pricedFields, commSchedule, commCollected, parentId: draft.parentId || null, opportunityId: draft.parentId || id };
  await repo.updateDealLocked(id, patch, (current, lockedLines, lockedClawbacks) => {
    if (JSON.stringify(current.commSchedule) !== JSON.stringify(deal.commSchedule) || current.commCollected !== deal.commCollected) {
      throw new HttpError(409, `${id} collection changed while its terms were being edited — reload and try again`);
    }
    const proposed = { ...current, ...patch };
    guardDealClawbacks(proposed, lockedLines, lockedClawbacks);
    if (lockedLines.length) throw new HttpError(400, `${id} has payouts in the ledger — void them before changing its terms`);
    if (priced.creditLine === null) return;
    const used = priced.funded + current.draws.reduce((sum, draw) => sum + draw.amount, 0);
    if (used > priced.creditLine + 0.005) throw new HttpError(400, `Initial funding plus active draws (${used.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}) cannot exceed the credit line of ${priced.creditLine.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`);
  });
  await repo.writeAudit({ actorRepId, action: 'deal.update', targetRepId: null, path: `/api/admin/deals/${id}/terms`, detail: { funded: priced.funded, lender: priced.lender, product: priced.product, date: priced.date, gross: priced.gross } });
  return requireDeal(repo, id);
}

/** Tombstone a mistyped deal. History is retained; operational reads and the next books sync treat it as removed. */
export async function deleteDeal(repo: Repo, id: string, actorRepId: string): Promise<void> {
  const deal = await requireDeal(repo, id);
  const ctx = await repo.loadContext();
  if (ctx.lines.some((l) => l.dealId === id)) throw new HttpError(400, `${id} has payouts in the ledger — void them first`);
  if (ctx.clawbacks.some((c) => c.dealId === id)) throw new HttpError(400, `${id} has a clawback on record and cannot be deleted`);
  const children = ctx.deals.filter((d) => d.parentId === id);
  if (children.length) throw new HttpError(400, `${id} is the parent of ${children.map((d) => d.id).join(', ')} — re-parent or delete those first`);
  await repo.deleteDeal(id, actorRepId);
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
  for (const [label, rid, supplied] of [['Opener', patch.openerId, input.openerId !== undefined], ['Closer', patch.closerId, input.closerId !== undefined], ['Override', patch.overrideId, input.overrideId !== undefined]] as const) {
    if (rid && !reps.some((r) => r.id === rid)) throw new HttpError(400, `${label} rep ${rid} does not exist`);
    // Do not reject a retained historical assignment merely because the
    // identity later became portal-only. Only a newly supplied role is barred.
    if (rid && supplied && reps.find((r) => r.id === rid)?.commissionEligible === false) throw new HttpError(400, `${label} user is not commission-eligible and cannot be assigned to a commission role`);
  }
  if (!patch.openerId) patch.openerRate = 0;
  if (!patch.closerId) patch.closerRate = 0;
  if (!patch.overrideId) patch.overrideRate = 0;
  await repo.updateDealLocked(id, patch, (current, lockedLines, lockedClawbacks) => {
    const proposed = { ...current, ...patch };
    const economicsChanged =
      current.openerId !== proposed.openerId ||
      current.openerRate !== proposed.openerRate ||
      current.closerId !== proposed.closerId ||
      current.closerRate !== proposed.closerRate ||
      current.overrideId !== proposed.overrideId ||
      current.overrideRate !== proposed.overrideRate;
    const hasStandingCommissionPayout = standingLines(lockedLines).some((line) =>
      line.role === 'Opener' || line.role === 'Closer' || line.role === 'Override');
    guardDealClawbacks(proposed, lockedLines, lockedClawbacks);
    if (economicsChanged && hasStandingCommissionPayout) {
      throw new HttpError(400, `${id} has payouts in the ledger — void them before changing its splits`);
    }
  });
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
  let draw: DealDraw;
  try {
    draw = await repo.insertDrawLocked(id, (current, lockedLines, lockedClawbacks) => {
      const proposedDraw = newDraw(current, {
        amount: Number(input.amount),
        date,
        partner,
        termDays: input.termDays ? Number(input.termDays) : null,
        factor: input.factor ? Number(input.factor) : null,
        // Draw rows never own a nested consolidation funding schedule.
        schedule: null,
      });
      guardDealClawbacks({ ...current, draws: [...current.draws, proposedDraw] }, lockedLines, lockedClawbacks);
      return proposedDraw;
    });
  } catch (e) {
    bad(e);
  }
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
  | { segmentKey: SegmentKey; stopIncrements: boolean; fundingReceived?: number | null }
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
  const buildPatch = (currentSeg: NonNullable<ReturnType<typeof segmentOf>>) => {
    let patch;
    if ('dollars' in input) patch = withCollection(currentSeg, Number(input.dollars));
    else if ('status' in input) patch = withStatus(currentSeg, input.status, input.partialDollars);
    else if ('recordWeeks' in input) {
      patch = recordWeek(currentSeg, Number(input.recordWeeks));
      if (!patch) throw new HttpError(400, `${id} ${currentSeg.sk} is not on an incremental schedule`);
    } else if ('markUpfront' in input) {
      patch = withUpfront(currentSeg, !!input.markUpfront);
      if (!patch) throw new HttpError(400, `${id} ${currentSeg.sk} has no upfront share`);
    } else if ('markRemainder' in input) {
      patch = withRemainder(currentSeg, !!input.markRemainder);
      if (!patch) throw new HttpError(400, `${id} ${currentSeg.sk} has no at-end remainder`);
    } else if ('amounts' in input) {
      try {
        patch = withAmounts(currentSeg, Array.isArray(input.amounts) ? input.amounts.map(Number) : null);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : 'Bad increment grid');
      }
      if (!patch) throw new HttpError(400, `${id} ${currentSeg.sk} is not funded in increments`);
    } else if ('stopIncrements' in input) {
      try {
        patch = withStopped(currentSeg, !!input.stopIncrements, input.fundingReceived === undefined ? null : Number(input.fundingReceived));
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : 'Bad final funding amount');
      }
      if (!patch) throw new HttpError(400, `${id} ${currentSeg.sk} is not funded in increments`);
    } else {
      const schedule = currentSeg.schedule;
      if (schedule) patch = recordWeek(currentSeg, schedule.received >= schedule.weeks ? -schedule.weeks : 1)!;
      else patch = withCollection(currentSeg, collectedOf(currentSeg) >= currentSeg.gross ? 0 : currentSeg.gross);
    }
    if (!patch) throw new HttpError(400, `${id} ${seg.sk} is not on an incremental schedule`);
    return patch;
  };
  let collected = 0;
  await repo.updateSegmentLocked(id, input.segmentKey, (current, lockedLines, lockedClawbacks) => {
    const currentSeg = segmentOf(current, input.segmentKey);
    if (!currentSeg) throw new HttpError(404, `Segment ${input.segmentKey} not found on ${id}`);
    const patch = buildPatch(currentSeg);
    const proposed = proposedSegmentDeal(current, input.segmentKey, patch);
    guardDealClawbacks(proposed, lockedLines, lockedClawbacks);
    collected = collectedOf({ ...currentSeg, ...patch });
    return { ...patch, ...(input.segmentKey === 'base' ? { lenderPaid: collected > 0 ? current.lenderPaid ?? today() : null } : {}) };
  });
  await repo.writeAudit({ actorRepId, action: 'deal.collection', targetRepId: null, path: `/api/admin/deals/${id}/collection`, detail: { segmentKey: seg.sk, collected } });
  return requireDeal(repo, id);
}

/** Atomically add an exact lender receipt without using a stale absolute target. */
export async function addCollectionDelta(repo: Repo, id: string, segmentKey: SegmentKey, delta: number, actorRepId: string): Promise<number> {
  const amount = Math.round(Number(delta) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Collection delta must be positive');
  let applied = 0;
  await repo.updateSegmentLocked(id, segmentKey, (current, lockedLines, lockedClawbacks) => {
    const seg = segmentOf(current, segmentKey);
    if (!seg) throw new HttpError(404, `Segment ${segmentKey} not found on ${id}`);
    const have = collectedOf(seg);
    const outstanding = Math.round((seg.gross - have) * 100) / 100;
    if (amount > outstanding + 0.005) throw new HttpError(409, `Receipt ${amount.toFixed(2)} exceeds current outstanding ${outstanding.toFixed(2)}`);
    const patch = withCollection(seg, Math.round((have + amount) * 100) / 100);
    const nextCollected = collectedOf({ ...seg, ...patch });
    applied = Math.round((nextCollected - have) * 100) / 100;
    if (Math.abs(applied - amount) > 0.005) throw new HttpError(409, `Receipt ${amount.toFixed(2)} cannot be represented exactly by this collection schedule`);
    const proposed = proposedSegmentDeal(current, segmentKey, patch);
    guardDealClawbacks(proposed, lockedLines, lockedClawbacks);
    return { ...patch, ...(segmentKey === 'base' ? { lenderPaid: current.lenderPaid ?? today() } : {}) };
  });
  await repo.writeAudit({ actorRepId, action: 'deal.collection', targetRepId: null, path: `/api/sync/remittance`, detail: { segmentKey, delta: applied } });
  return applied;
}

/** The CRM's deal ID (the F-number is only the sheet row). */
export async function setCrmId(repo: Repo, id: string, crmId: string | null, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, id);
  const value = crmId?.trim() || null;
  await repo.updateDeal(id, { crmId: value });
  await repo.writeAudit({ actorRepId, action: 'deal.update', targetRepId: null, path: `/api/admin/deals/${id}/crm`, detail: { crmId: value } });
  return { ...deal, crmId: value };
}

/** Correct imported CRM attribution or its legacy deal note without changing money or ledger history. */
export async function updateDealMetadata(repo: Repo, id: string, input: { leadSource?: unknown; notes?: unknown }, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, id);
  const text = (v: unknown, current: string | null | undefined) => v === undefined ? current ?? null : String(v ?? '').trim().slice(0, 2_000) || null;
  const patch = { leadSource: text(input.leadSource, deal.leadSource), notes: text(input.notes, deal.notes) };
  await repo.updateDeal(id, patch);
  await repo.writeAudit({ actorRepId, action: 'deal.update', targetRepId: null, path: `/api/admin/deals/${id}/metadata`, detail: patch });
  return { ...deal, ...patch };
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
  const clawback = await repo.mutateClawback(dealId, null, ({ deal, activeClawbacks, lines }) => {
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Clawback amount must be more than zero');
    const date = String(input.date ?? today()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Clawback date must be YYYY-MM-DD');
    if (date > today()) throw new HttpError(400, 'Clawback date cannot be in the future');
    if (date < deal.date) throw new HttpError(400, `Clawback date is before the deal funded (${deal.date})`);
    const next: Clawback = { id: `cb-${globalThis.crypto.randomUUID()}`, dealId, date, amount, recovered: 0, reason: String(input.reason ?? '').trim().slice(0, 500), status: 'open' };
    guardDealClawbacks(deal, lines, [...activeClawbacks, next]);
    return { result: next, create: next };
  });
  await repo.writeAudit({ actorRepId, action: 'deal.clawback', targetRepId: null, path: `/api/admin/deals/${dealId}/clawbacks`, detail: { clawbackId: clawback.id, amount: clawback.amount, date: clawback.date } });
  return clawback;
}

/** Remove a draw that was entered by mistake. Refused once any ledger row (paid or voided) references it. */
export async function deleteDraw(repo: Repo, dealId: string, ref: string, actorRepId: string): Promise<Deal> {
  const deal = await requireDeal(repo, dealId);
  const draw = deal.draws.find((d) => d.ref === ref);
  if (!draw) throw new HttpError(404, `Draw ${ref} not found on ${dealId}`);
  await repo.deleteDrawLocked(dealId, ref, (proposed, lockedLines, lockedClawbacks) => {
    if (lockedLines.some((line) => line.segmentKey === ref)) throw new HttpError(400, `${dealId} ${ref} has been paid on — void those payouts first, then remove the draw`);
    guardDealClawbacks(proposed, lockedLines, lockedClawbacks);
  });
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
  let next: DealDraw;
  try {
    next = await repo.replaceDrawLocked(dealId, ref, (current, lockedLines, lockedClawbacks) => {
      if (lockedLines.some((line) => line.segmentKey === ref)) throw new HttpError(400, `${dealId} ${ref} has been paid on — void those payouts first, then edit the draw`);
      const currentDraw = current.draws.find((d) => d.ref === ref);
      if (!currentDraw) throw new HttpError(404, `Draw ${ref} not found on ${dealId}`);
      const others = current.draws.filter((d) => d.ref !== ref);
      const repriced = newDraw({ ...current, draws: others }, {
        amount,
        date,
        commRate,
        partner,
        termDays: numOr(input.termDays, currentDraw.termDays),
        factor: numOr(input.factor, currentDraw.factor),
        schedule: currentDraw.schedule ? { mode: 'weekly', weeks: currentDraw.schedule.weeks, received: 0, startDate: date } : null,
        frequency: current.frequency,
        referralPaidThisMonth: referralPaidInMonth(ctx.deals.filter((d) => d.id !== dealId), current.referralPartner, date),
      });
      const replacement = { ...repriced, n: currentDraw.n, ref: currentDraw.ref, collected: currentDraw.schedule ? null : Math.min(currentDraw.collected ?? 0, repriced.gross), schedule: currentDraw.schedule ? { ...currentDraw.schedule, startDate: date } : null };
      const proposed = { ...current, draws: current.draws.map((draw) => draw.ref === ref ? replacement : draw) };
      guardDealClawbacks(proposed, lockedLines, lockedClawbacks);
      return replacement;
    });
  } catch (e) {
    bad(e);
  }
  await repo.writeAudit({ actorRepId, action: 'deal.draw.update', targetRepId: null, path: `/api/admin/deals/${dealId}/draws/${ref}`, detail: { amount: next.amount, date: next.date, commRate: next.commRate, gross: next.gross } });
  return requireDeal(repo, dealId);
}

/** Correct a clawback. The amount can only drop as far as what reps have already repaid on it. */
export async function updateClawback(repo: Repo, dealId: string, clawbackId: string, input: { amount?: unknown; date?: unknown; reason?: unknown }, actorRepId: string): Promise<Clawback> {
  const updated = await repo.mutateClawback(dealId, clawbackId, ({ deal, clawback, activeClawbacks, lines }) => {
    if (!clawback || clawback.forgivenAt) throw new HttpError(404, 'Clawback not found');
    const patch: Partial<Pick<Clawback, 'amount' | 'date' | 'reason'>> = {};
    if (input.amount !== undefined) {
      const amount = Math.round(Number(input.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Clawback amount must be more than zero');
      patch.amount = amount;
    }
    if (input.date !== undefined) {
      const date = String(input.date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today() || date < deal.date) throw new HttpError(400, 'Clawback date must be between the funded date and today');
      patch.date = date;
    }
    if (input.reason !== undefined) patch.reason = String(input.reason ?? '').trim().slice(0, 500);
    const next = { ...clawback, ...patch };
    guardDealClawbacks(deal, lines, activeClawbacks.map((current) => current.id === clawback.id ? next : current));
    return { result: { ...next }, update: patch };
  });
  await repo.writeAudit({ actorRepId, action: 'deal.clawback.update', targetRepId: null, path: `/api/admin/deals/${dealId}/clawbacks/${clawbackId}`, detail: { amount: updated.amount, date: updated.date, reason: updated.reason } });
  return updated;
}

/** Forgive / remove a clawback recorded in error. Refused once any rep has repaid on it — void those recoveries first. */
export async function deleteClawback(repo: Repo, dealId: string, clawbackId: string, actorRepId: string): Promise<void> {
  const cb = await repo.mutateClawback(dealId, clawbackId, ({ clawback, lines }) => {
    if (!clawback || clawback.forgivenAt) throw new HttpError(404, 'Clawback not found');
    if (clawbackRecovered(lines, clawback.id) > 0) throw new HttpError(400, 'Reps have repaid on this clawback — void those recovery rows in payroll first');
    return { result: clawback, forgive: true };
  });
  await repo.writeAudit({ actorRepId, action: 'deal.clawback.delete', targetRepId: null, path: `/api/admin/deals/${dealId}/clawbacks/${cb.id}`, detail: { amount: cb.amount, date: cb.date } });
}
