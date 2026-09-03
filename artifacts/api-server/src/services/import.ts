/**
 * Import the existing tracker (FUNDED DEALS tab, exported as CSV). Preview
 * first: every row is resolved against Settings and the roster and reported
 * with its problems; commit only when the file is clean. Deals go through
 * priceDeal, draws through newDraw, statuses become collection, clawbacks
 * become clawback records, and "Rep Paid Date" becomes real ledger rows in
 * a paid run called "Imported from sheet" — so history is in the ledger too.
 */
import {
  clawbackStatus,
  dealLines,
  isDealFullyPaid,
  newDraw,
  nextDealId,
  priceDeal,
  recordWeek,
  withStatus,
  type Clawback,
  type Deal,
  type PayoutLine,
  type Rep,
} from '@greystone/commission';
import { collectedFromSheetStatus, parsePsfCell } from '@greystone/db/seed/columns';
import { readFundedDealsCsv, type SheetRow } from '@greystone/db/seed/csv';
import { HttpError } from '../http-error.js';
import type { Repo, Settings } from '../repo.js';
import { referralPaidInMonth } from './deals.js';

const today = () => new Date().toISOString().slice(0, 10);

export interface ImportRowPreview {
  line: number;
  id: string;
  action: 'deal' | 'draw';
  parentId: string | null;
  business: string;
  lender: string;
  product: string;
  amount: number;
  date: string;
  opener: string | null;
  closer: string | null;
  override: string | null;
  commissionStatus: string;
  repPaid: string | null;
  clawback: number | null;
  problems: string[];
  /** Non-blocking notes: something was adjusted on the way in. */
  warnings: string[];
}

export interface ImportPreview {
  rows: ImportRowPreview[];
  skipped: number;
  problems: string[];
  summary: { deals: number; draws: number; funded: number; withPayouts: number; warnings: number; clawbacks: number; problems: number };
}

function repByName(reps: Rep[], name: string): Rep | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  return reps.find((r) => r.name.toLowerCase() === n) ?? reps.find((r) => r.name.toLowerCase().startsWith(n)) ?? reps.find((r) => r.email.toLowerCase() === n);
}

/** Resolve every row against settings and the roster. Pure apart from reads. */
export async function previewImport(repo: Repo, csv: string): Promise<ImportPreview> {
  const [settings, reps, ctx] = await Promise.all([repo.getSettings(), repo.listReps(), repo.loadContext()]);
  const read = readFundedDealsCsv(csv);
  const existing = new Set(ctx.deals.map((d) => d.id));
  const seen = new Set<string>();
  const ids = new Set(read.rows.map((r) => r.id).filter(Boolean));
  const rows: ImportRowPreview[] = read.rows.map((r) => {
    const problems: string[] = [];
    const warnings: string[] = [];
    const rule = settings.products.find((p) => p.name.toLowerCase() === r.product.toLowerCase());
    const lender = settings.lenders.find((l) => l.name.toLowerCase() === r.lender.toLowerCase());
    if (!rule) problems.push(`Unknown product "${r.product}" — add it in Settings › Product rules`);
    if (!lender) problems.push(`Unknown lender "${r.lender}" — add it in Settings › Lenders`);
    if (r.referralPartner && r.referralPartner.toLowerCase() !== 'none' && !settings.partners.some((p) => p.name.toLowerCase() === r.referralPartner.toLowerCase())) problems.push(`Unknown referral partner "${r.referralPartner}"`);
    if (!r.date) problems.push('Date is missing or unreadable');
    else if (r.date > today()) problems.push(`Funded date ${r.date} is in the future`);
    if (!(r.amount > 0)) problems.push('Amount must be positive');
    const who = (label: string, name: string) => {
      if (!name) return null;
      const rep = repByName(reps, name);
      if (!rep) problems.push(`${label} "${name}" is not on the roster — add the rep in Settings › Reps`);
      return rep?.id ?? null;
    };
    const opener = who('Opener', r.opener);
    const closer = who('Closer', r.closer);
    const override = who('Override', r.override);
    const isDraw = !!r.parent && r.parent !== r.id && (rule?.basis === 'draw' || rule?.parent === true || ids.has(r.parent) || existing.has(r.parent));
    if (isDraw && !ids.has(r.parent) && !existing.has(r.parent)) problems.push(`Parent deal ${r.parent} is not in the file or the portal`);
    if (!isDraw) {
      if (r.id && !/^F\d+$/.test(r.id)) problems.push(`Deal ID "${r.id}" is not an F-number; leave it blank to let the portal assign one`);
      if (r.id && existing.has(r.id)) problems.push(`${r.id} already exists in the portal`);
      if (r.id && seen.has(r.id)) warnings.push(`${r.id} appears twice in the file — this copy gets the next free id`);
      if (r.id) seen.add(r.id);
    }
    if (r.repPaid && r.repPaid > today()) problems.push(`Rep paid date ${r.repPaid} is in the future`);
    return {
      line: r.line,
      id: r.id,
      action: isDraw ? 'draw' : 'deal',
      parentId: isDraw ? r.parent : null,
      business: r.business,
      lender: r.lender,
      product: r.product,
      amount: r.amount,
      date: r.date,
      opener: opener ? reps.find((x) => x.id === opener)!.name : r.opener || null,
      closer: closer ? reps.find((x) => x.id === closer)!.name : r.closer || null,
      override: override ? reps.find((x) => x.id === override)!.name : r.override || null,
      commissionStatus: r.commissionStatus,
      repPaid: r.repPaid || null,
      clawback: r.clawbackAmount,
      problems,
      warnings,
    };
  });
  const problems = [...read.problems];
  const deals = rows.filter((x) => x.action === 'deal');
  return {
    rows,
    skipped: read.skipped,
    problems,
    summary: {
      deals: deals.length,
      draws: rows.length - deals.length,
      funded: Math.round(rows.reduce((s, x) => s + x.amount, 0) * 100) / 100,
      withPayouts: rows.filter((x) => x.repPaid).length,
      warnings: rows.reduce((s, x) => s + x.warnings.length, 0),
      clawbacks: rows.filter((x) => x.clawback).length,
      problems: problems.length + rows.reduce((s, x) => s + x.problems.length, 0),
    },
  };
}

export interface ImportResult {
  deals: number;
  draws: number;
  clawbacks: number;
  payoutLines: number;
  runId: string | null;
}

/** Commit a clean file. Refuses if the preview has any problem. */
export async function commitImport(repo: Repo, csv: string, actorRepId: string): Promise<ImportResult> {
  const preview = await previewImport(repo, csv);
  if (preview.summary.problems > 0) throw new HttpError(400, `Fix the ${preview.summary.problems} problem(s) in the preview before importing`);
  const [settings, reps, ctx] = await Promise.all([repo.getSettings(), repo.listReps(), repo.loadContext()]);
  const read = readFundedDealsCsv(csv);
  const byLine = new Map(read.rows.map((r) => [r.line, r]));
  const known: Deal[] = [...ctx.deals];
  const created: Deal[] = [];
  // The sheet's F-series counts draw rows too, so every id in the file is reserved before new ones are issued.
  let ids = [...known.map((d) => d.id), ...read.rows.map((r) => r.id).filter((id) => /^F\d+$/.test(id))];
  const rule = (name: string) => settings.products.find((p) => p.name.toLowerCase() === name.toLowerCase())!;
  const lenderOf = (name: string) => settings.lenders.find((l) => l.name.toLowerCase() === name.toLowerCase());
  const partnerOf = (name: string) => settings.partners.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const repId = (name: string) => repByName(reps, name)?.id ?? null;
  const rate = (v: number | null, fallback: number | null | undefined) => (v === null ? fallback ?? null : v);
  /** The sheet lets ops overtype a role's dollars. When that disagrees with rate × gross, the typed amount wins: rate = dollars ÷ gross. */
  const effectiveRate = (r: SheetRow, pct: number | null, dollars: number | null, fallback: number | null | undefined): number | null => {
    const base = rate(pct, fallback);
    if (dollars === null || !(r.gross && r.gross > 0)) return base;
    const asRateV = base === null ? null : base > 1 ? base / 100 : base;
    if (asRateV !== null && Math.abs(r.gross * asRateV - dollars) <= 1) return base;
    return Math.round((dollars / r.gross) * 1e6) / 1e6;
  };

  // Deals first (parents before draws), in file order.
  for (const row of preview.rows.filter((x) => x.action === 'deal')) {
    const r = byLine.get(row.line)!;
    const id = r.id && /^F\d+$/.test(r.id) && !created.some((d) => d.id === r.id) ? r.id : nextDealId(ids);
    ids = [...ids, id];
    const pr = rule(r.product);
    // The sheet's PSF $ column is what its gross actually used; fall back to the % cell only when N is blank.
    const psf = r.psfDollars !== null ? { psfRate: 0, psfDollars: r.psfDollars } : parsePsfCell(r.psf);
    const deal = priceDeal(
      {
        business: r.business,
        fundedDate: r.date,
        lender: lenderOf(r.lender)!.name,
        product: pr.name,
        amount: r.amount,
        termDays: r.termDays,
        factor: pr.factor ? r.factor : null,
        apr: pr.factor ? null : r.factor,
        frequency: r.frequency,
        commRate: rate(r.commRate, pr.multiDraw ? pr.drawInitial : pr.comm),
        psfPct: psf.psfRate ? psf.psfRate : psf.psfDollars && r.amount ? psf.psfDollars / r.amount : 0,
        originationFee: 0,
        referralPartner: r.referralPartner && r.referralPartner.toLowerCase() !== 'none' ? partnerOf(r.referralPartner)!.name : null,
        openerId: repId(r.opener),
        openerRate: effectiveRate(r, r.openerRate, r.openerDollars, repByName(reps, r.opener)?.openerRate),
        closerId: repId(r.closer),
        closerRate: effectiveRate(r, r.closerRate, r.closerDollars, repByName(reps, r.closer)?.closerRate),
        overrideId: repId(r.override),
        overrideRate: effectiveRate(r, r.overrideRate, r.overrideDollars, repByName(reps, r.override)?.overrideRate ?? 0.05),
        leadSource: r.leadSource || 'Sheet import',
        notes: r.notes || null,
      },
      { id, today: today(), rule: pr, lender: lenderOf(r.lender), partner: r.referralPartner ? partnerOf(r.referralPartner) : undefined, referralPaidThisMonth: referralPaidInMonth([...known, ...created], r.referralPartner, r.date) },
    );
    // Sheet status → collection. Weekly schedules: Paid In Full = every increment received.
    const seg = { gross: deal.gross, collected: deal.commCollected, schedule: deal.commSchedule };
    if (deal.commSchedule) {
      if (r.commissionStatus === 'YES - Paid In Full') deal.commSchedule = recordWeek(seg, deal.commSchedule.weeks)!.schedule;
      else if (r.commissionStatus === 'Partially Paid') deal.commSchedule = recordWeek(seg, Math.floor(deal.commSchedule.weeks / 2))!.schedule;
    } else {
      deal.commCollected = collectedFromSheetStatus(r.commissionStatus, deal.gross);
    }
    deal.lenderPaid = r.lenderPaid || (deal.commCollected ? r.date : null);
    if (r.dealStatus && settings.lists.dealStatuses.includes(r.dealStatus)) deal.dealStatus = r.dealStatus;
    const draws = [...deal.draws];
    deal.draws = draws;
    await repo.insertDeal(deal);
    created.push(deal);
  }
  // Draws under their parents.
  let drawCount = 0;
  const all = [...known, ...created];
  for (const row of preview.rows.filter((x) => x.action === 'draw')) {
    const r = byLine.get(row.line)!;
    const parent = all.find((d) => d.id === row.parentId);
    if (!parent) throw new HttpError(400, `Parent ${row.parentId} vanished`);
    const ln = lenderOf(parent.lender);
    const draw = newDraw(parent, {
      amount: r.amount,
      date: r.date,
      commRate: r.commRate === null ? undefined : r.commRate > 1 ? r.commRate / 100 : r.commRate,
      partner: parent.referralPartner ? partnerOf(parent.referralPartner) ?? null : null,
      termDays: r.termDays,
      factor: r.factor,
      schedule: rule(parent.product).incremental && ln?.terms === 'weekly' ? { mode: 'weekly', weeks: ln.weeks, received: r.commissionStatus === 'YES - Paid In Full' ? ln.weeks : 0, startDate: r.date } : null,
      frequency: r.frequency,
    });
    if (!draw.schedule) draw.collected = collectedFromSheetStatus(r.commissionStatus, draw.gross);
    await repo.insertDraw(parent.id, draw);
    parent.draws = [...parent.draws, draw];
    drawCount++;
  }
  // Clawbacks.
  let clawbacks = 0;
  for (const row of preview.rows.filter((x) => x.action === 'deal' && x.clawback)) {
    const r = byLine.get(row.line)!;
    const deal = created.find((d) => d.business === r.business && d.date === r.date && d.funded === r.amount) ?? created.find((d) => d.id === r.id);
    if (!deal) continue;
    const c: Clawback = { id: `cb-${deal.id.toLowerCase()}-import`, dealId: deal.id, date: r.clawbackDate || r.date, amount: r.clawbackAmount!, recovered: 0, reason: 'Imported from sheet', status: 'open' };
    c.status = clawbackStatus(c, deal, ctx.lines);
    await repo.insertClawback(c);
    clawbacks++;
  }
  // Payouts the sheet says already happened → ledger rows in one imported, paid run.
  const lines: PayoutLine[] = [];
  const paidDeals = new Map<string, string>();
  for (const row of preview.rows) {
    const r = byLine.get(row.line)!;
    if (!r.repPaid) continue;
    const deal = row.action === 'deal' ? created.find((d) => d.business === r.business && d.date === r.date && d.funded === r.amount) : all.find((d) => d.id === row.parentId);
    if (!deal) continue;
    paidDeals.set(deal.id, r.repPaid);
  }
  const runId = paidDeals.size ? `import-${today()}` : null;
  if (runId) {
    const existingKeys = new Set(ctx.lines.map((l) => l.key));
    for (const [dealId, paidAt] of paidDeals) {
      const deal = all.find((d) => d.id === dealId)!;
      for (const l of dealLines(deal)) {
        if (existingKeys.has(l.key)) continue;
        lines.push({ key: l.key, dealId: l.dealId, segmentKey: l.segmentKey, role: l.role, repId: l.repId, amount: l.amount, runId, clawbackId: null, paidAt });
        existingKeys.add(l.key);
      }
    }
    await repo.insertRun({ id: runId, label: 'Imported from sheet', start: [...paidDeals.values()].sort()[0]!, end: today(), status: 'paid' });
    const after = [...ctx.lines, ...lines];
    await repo.commitPayout({ lines, clawbackUpdates: [], dealsFullyPaid: [], paidAt: today() });
    for (const [id, paidAt] of paidDeals) if (isDealFullyPaid(all.find((d) => d.id === id)!, after)) await repo.updateDeal(id, { repPaid: paidAt });
  }
  await repo.writeAudit({ actorRepId, action: 'deal.import', targetRepId: null, path: '/api/admin/import', detail: { deals: created.length, draws: drawCount, clawbacks, payoutLines: lines.length, runId } });
  return { deals: created.length, draws: drawCount, clawbacks, payoutLines: lines.length, runId };
}
