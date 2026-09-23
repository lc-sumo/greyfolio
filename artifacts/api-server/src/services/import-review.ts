import { createHash } from 'node:crypto';
import { lenderSupportsProduct, clawbackStatus, collectedOf, dealLines, newDraw, nextRowKey, recordWeek, rowBase, segmentOf, standingLines } from '@greystone/commission';
import { readFundedDealsCsv, type SheetRow } from '@greystone/db/seed/csv';
import { HttpError } from '../http-error.js';
import type { ImportReview, ImportReviewDecision, Repo } from '../repo.js';
import { priceDeal, type Deal, type DealDraw, type Clawback, type PayoutLine, type LedgerContext } from '@greystone/commission';

const money = (n: number) => Math.round(n * 100) / 100;
const validDate = (value: string | null) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  && value <= new Date().toISOString().slice(0, 10);
type Terms = NonNullable<ImportReviewDecision['terms']>;
const textFields = ['parent', 'business', 'lender', 'product', 'frequency', 'referralPartner', 'opener', 'closer', 'override', 'dealStatus', 'notes', 'leadSource'] as const;
const dateFields = ['date', 'clawbackDate'] as const;
const numberFields = ['amount', 'factor', 'termDays', 'commRate', 'psf', 'psfDollars', 'gross', 'referralFee', 'totalRepPayout', 'openerRate', 'openerDollars', 'closerRate', 'closerDollars', 'overrideRate', 'overrideDollars', 'clawbackAmount'] as const;
const allowedFields = new Set<string>([...textFields, ...dateFields, ...numberFields]);
const verifiedTerms = (source: SheetRow, terms: Terms | undefined): SheetRow => ({ ...source, ...terms });

function validateTerms(input: unknown): asserts input is Terms {
  if (input === undefined) return;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid corrected deal fields');
  for (const [key, value] of Object.entries(input)) {
    if (!allowedFields.has(key)) throw new HttpError(400, `Deal field "${key}" cannot be edited here`);
    if ((textFields as readonly string[]).includes(key) && (typeof value !== 'string' || value.length > 2000)) throw new HttpError(400, `Invalid ${key}`);
    if ((dateFields as readonly string[]).includes(key) && (typeof value !== 'string' || (value !== '' && !validDate(value)))) throw new HttpError(400, `Invalid ${key} date`);
    if ((numberFields as readonly string[]).includes(key) && !(value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000_000))) throw new HttpError(400, `Invalid ${key} amount or rate`);
  }
}

export function suggestedReview(source: SheetRow, saved: ImportReviewDecision, status: ImportReview['status'],
  reps: Awaited<ReturnType<Repo['listReps']>> = []): ImportReviewDecision {
  if (status !== 'not_reviewed' && !(status === 'needs_attention'
    && !saved.termsConfirmed && saved.lender === 'unknown' && saved.reps === 'unknown' && !saved.notes && !saved.terms)) return saved;
  const repAmount = source.totalRepPayout && source.totalRepPayout > 0
    ? source.totalRepPayout : money((source.openerDollars ?? 0) + (source.closerDollars ?? 0) + (source.overrideDollars ?? 0)) || null;
  const repPayments: ImportReviewDecision['repPayments'] = [];
  if (source.repPaid) {
    for (const [name, role, amount] of [
      [source.opener, 'Opener', source.openerDollars],
      [source.closer, 'Closer', source.closerDollars],
      [source.override, 'Override', source.overrideDollars],
    ] as const) {
      const rep = reps.find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (rep && amount !== null && amount > 0)
        repPayments.push({ repId: rep.id, role, amount, paidAt: source.repPaid });
    }
  }
  return { ...saved,
    lender: source.lenderPaid ? 'paid' : source.commissionStatus.toLowerCase().includes('waiting') ? 'unpaid' : 'unknown',
    lenderAmount: source.lenderPaid ? source.gross : null, lenderDate: source.lenderPaid || null,
    reps: source.repPaid ? 'paid' : 'unpaid', repAmount: source.repPaid ? repAmount : null, repDate: source.repPaid || null,
    repPayments };
}

export async function stageTracker(repo: Repo, csv: string, actorRepId: string) {
  if (!csv || Buffer.byteLength(csv, 'utf8') > 4_000_000) throw new HttpError(400, 'Upload a CSV smaller than 4 MB');
  const parsed = readFundedDealsCsv(csv);
  if (parsed.problems.length) throw new HttpError(400, parsed.problems.join('; '));
  if (!parsed.rows.length || parsed.rows.length > 2000) throw new HttpError(400, 'Expected between 1 and 2,000 tracker rows');
  const counts = new Map<string, number>();
  for (const row of parsed.rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const keys = new Set<string>();
  for (const row of parsed.rows) {
    if (!/^F\d+$/.test(row.id)) throw new HttpError(400, `Line ${row.line}: missing or invalid Deal ID. Fix the CSV before staging.`);
    const key = counts.get(row.id)! > 1 ? `${row.id}:duplicate:${createHash('sha256').update(JSON.stringify([row.business, row.date, row.amount])).digest('hex').slice(0, 12)}` : row.id;
    if (keys.has(key)) throw new HttpError(400, `Line ${row.line}: indistinguishable duplicate Deal ID. Fix the CSV before staging.`);
    keys.add(key);
  }
  const result = await repo.stageImportReviews(parsed.rows.map((source) => ({
    sourceId: counts.get(source.id)! > 1 ? `${source.id}:duplicate:${createHash('sha256').update(JSON.stringify([source.business, source.date, source.amount])).digest('hex').slice(0, 12)}` : source.id,
    sourceHash: createHash('sha256').update(JSON.stringify({ ...source, line: undefined })).digest('hex'),
    source,
  })));
  await repo.writeAudit({ actorRepId, action: 'import-review.stage', targetRepId: null, path: '/api/admin/import-review', detail: { ...result, rows: parsed.rows.length } });
  return { ...result, total: parsed.rows.length, skippedTemplateRows: parsed.skipped };
}

export function trackerIssues(row: SheetRow, settings: Awaited<ReturnType<Repo['getSettings']>>, reps: Awaited<ReturnType<Repo['listReps']>> = []): string[] {
  const issues: string[] = [];
  const lender = settings.lenders.find((x) => x.name.toLowerCase() === row.lender.toLowerCase());
  const product = settings.products.find((x) => x.name.toLowerCase() === row.product.toLowerCase());
  if (!lender) issues.push(`Lender "${row.lender}" is missing from Settings`);
  if (!product) issues.push(`Product "${row.product}" is missing from Settings`);
  if (lender && product && !lenderSupportsProduct(lender, product)) issues.push(`${row.lender} is not configured for ${row.product}; verify the product against the lender`);
  for (const name of [row.opener, row.closer, row.override].filter(Boolean)) {
    if (reps.length && !reps.some((rep) => rep.name.toLowerCase() === name.toLowerCase()))
      issues.push(`Rep "${name}" is not an exact roster match; confirm the payee before importing`);
  }
  if (!row.business || !row.date || !(row.amount > 0)) issues.push('Business, funded date and amount are required');
  if (row.totalRepPayout !== null && row.gross !== null && row.totalRepPayout > row.gross - (row.referralFee ?? 0) + .01)
    issues.push('Rep payout exceeds gross commission minus referral fee');
  if (row.gross !== null && row.commRate !== null && row.amount > 0) {
    const basis = product?.basis === 'payback' && row.factor ? row.amount * row.factor : row.amount;
    const psf = row.psfDollars ?? (row.psf !== null ? row.psf > 100 ? row.psf : basis * (row.psf > 1 ? row.psf / 100 : row.psf) : 0);
    const predicted = money(basis * (row.commRate > 1 ? row.commRate / 100 : row.commRate) + psf);
    if (Math.abs(predicted - row.gross) > 1) issues.push(`Sheet gross ${money(row.gross)} differs from confirmed commission basis × rate + PSF (${predicted})`);
  }
  if (row.totalRepPayout !== null) {
    const roleSum = money((row.openerDollars ?? 0) + (row.closerDollars ?? 0) + (row.overrideDollars ?? 0));
    if (Math.abs(roleSum - row.totalRepPayout) > 1) issues.push(`Sheet role payouts ${roleSum} differ from total rep payout ${row.totalRepPayout}`);
  }
  return issues;
}

export async function listTrackerReviews(repo: Repo) {
  const [rows, settings, context, reps] = await Promise.all([repo.listImportReviews(), repo.getSettings(), repo.loadContext(), repo.listReps()]);
  const existing = new Set(context.deals.map((x) => x.id));
  return rows.map((row) => ({
    ...row,
    review: suggestedReview(row.source, row.review, row.status, reps),
    issues: [...(row.sourceId.includes(':duplicate:') ? [`Deal ID ${row.source.id} is duplicated in this sheet. Correct the IDs before using either row for a live import.`] : []), ...trackerIssues(verifiedTerms(row.source, row.review.terms), settings, reps)],
    alreadyInPortal: existing.has(row.source.id),
  }));
}

export async function saveTrackerReview(repo: Repo, id: string, revision: number, input: ImportReviewDecision, status: ImportReview['status'], actorRepId: string) {
  const current = (await repo.listImportReviews()).find((x) => x.sourceId === id);
  if (!current) throw new HttpError(404, 'Tracker row not found');
  if (current.status === 'imported') throw new HttpError(409, 'This row was already imported and cannot be reviewed again.');
  if (current.revision !== revision) throw new HttpError(409, 'This row changed in another session. Refresh to see the latest review before saving.');
  if (!['not_reviewed', 'in_progress', 'needs_attention', 'reviewed'].includes(status)) throw new HttpError(400, 'Invalid review status');
  input = { ...input, repPayments: input?.repPayments ?? [], lenderWeeks: input?.lenderWeeks ?? null };
  if (typeof input?.termsConfirmed !== 'boolean' || !['unknown', 'unpaid', 'paid'].includes(input.lender)
    || !['unknown', 'unpaid', 'paid'].includes(input.reps) || typeof input.notes !== 'string' || input.notes.length > 2000) throw new HttpError(400, 'Invalid review answers');
  validateTerms(input.terms);
  const corrected = verifiedTerms(current.source, input.terms);
  if (corrected.parent && (!/^F\d+$/.test(corrected.parent) || corrected.parent === corrected.id)) throw new HttpError(400, 'Parent deal ID must name a different valid deal');
  if (corrected.amount <= 0 || !validDate(corrected.date)) throw new HttpError(400, 'Enter a positive funding amount and a valid funded date');
  if (corrected.commRate !== null && corrected.commRate > 100) throw new HttpError(400, 'Commission rate must not exceed 100%');
  if (corrected.termDays !== null && !Number.isInteger(corrected.termDays)) throw new HttpError(400, 'Term must be a whole number of days');
  for (const rate of [corrected.openerRate, corrected.closerRate, corrected.overrideRate])
    if (rate !== null && rate > 100) throw new HttpError(400, 'Role rates must not exceed 100%');
  const amount = (n: unknown) => n === null || (typeof n === 'number' && Number.isFinite(n) && n > 0 && money(n) === n);
  if (!amount(input.lenderAmount) || !amount(input.repAmount)) throw new HttpError(400, 'Amounts must be positive dollars and cents');
  if (input.lenderWeeks !== null && (!Number.isInteger(input.lenderWeeks) || input.lenderWeeks < 0)) throw new HttpError(400, 'Lender weeks must be a non-negative integer or null');
  if (!Array.isArray(input.repPayments) || input.repPayments.some((p) => !p || !['Opener', 'Closer', 'Override'].includes(p.role) || typeof p.repId !== 'string' || !amount(p.amount) || !validDate(p.paidAt))) throw new HttpError(400, 'Rep payments must contain explicit rep, role, amount, and actual paid date');
  if (input.lender === 'paid' && (!input.lenderAmount || !validDate(input.lenderDate))) throw new HttpError(400, 'Enter the lender amount received and its actual date');
  if (input.reps === 'paid' && (!input.repAmount || !validDate(input.repDate))) throw new HttpError(400, 'Enter the amount actually paid to reps and its actual date');
  if (input.lender !== 'paid' && (input.lenderAmount !== null || input.lenderDate !== null)
    || input.reps !== 'paid' && (input.repAmount !== null || input.repDate !== null)) throw new HttpError(400, 'Clear payment amounts and dates for unpaid or unknown answers');
  if (input.reps !== 'paid' && input.repPayments.length) throw new HttpError(400, 'Clear explicit repPayments for unpaid or unknown reps');
  if (input.reps === 'paid' && input.repAmount !== null && money(input.repPayments.reduce((n, p) => n + p.amount, 0)) !== input.repAmount) throw new HttpError(400, 'Explicit repPayments must add up to the total rep amount');
  if (input.lenderAmount && corrected.gross !== null && input.lenderAmount > corrected.gross + 0.01) throw new HttpError(400, 'Lender receipt exceeds the confirmed gross commission; correct the terms or receipt');
  if (input.repAmount && corrected.totalRepPayout !== null && input.repAmount > corrected.totalRepPayout + 0.01) throw new HttpError(400, 'Rep payment exceeds the confirmed total rep payout; correct the terms or payment');
  if (status === 'reviewed') {
    if (!input.termsConfirmed || input.lender === 'unknown' || input.reps === 'unknown') throw new HttpError(400, 'Confirm terms and both payment answers before marking reviewed');
    if (input.reps === 'paid' && !input.repPayments.length) throw new HttpError(400, 'Identify the amount, role and date for each rep paid before marking reviewed');
    const [settings, reps] = await Promise.all([repo.getSettings(), repo.listReps()]);
    const issues = [...(current.sourceId.includes(':duplicate:') ? ['Duplicate Deal ID'] : []), ...trackerIssues(corrected, settings, reps)];
    if (corrected.parent && !(await repo.listImportReviews()).some((r) => r.source.id === corrected.parent)
      && !(await repo.loadContext()).deals.some((d) => d.id === corrected.parent))
      issues.push(`Parent ${corrected.parent} is not staged or in the portal`);
    if (issues.length) throw new HttpError(400, `Resolve these issues first: ${issues.join('; ')}`);
  }
  const saved = await repo.saveImportReview(id, revision, input, status, actorRepId);
  if (!saved) throw new HttpError(409, 'This row changed in another session. Refresh before saving.');
  await repo.writeAudit({ actorRepId, action: 'import-review.save', targetRepId: null, path: `/api/admin/import-review/${id}`, detail: { sourceId: id, status, revision: saved.revision } });
  return saved;
}

export interface ImportReviewPreview {
  sourceId: string; revision: number; action: 'new' | 'existing' | 'draw' | 'blocked';
  deal: Deal | null; draw: DealDraw | null; receipt: { amount: number; paidAt: string } | null;
  payouts: Array<{ repId: string; role: string; amount: number; paidAt: string; key: string; alreadyPosted: boolean }>;
  clawback: Clawback | null; problems: string[]; previewToken: string;
}

const reviewToken = (row: ImportReview, context: LedgerContext, settings: Awaited<ReturnType<Repo['getSettings']>>, reps: Awaited<ReturnType<Repo['listReps']>>) => createHash('sha256')
  .update(JSON.stringify({ row, deals: context.deals, lines: context.lines, clawbacks: context.clawbacks, settings: [settings.lenders, settings.products, settings.partners], reps: reps.map(({ id, name }) => ({ id, name })) })).digest('hex');

/** Authoritative, side-effect-free preview. Explicit repPayments are the only payout input. */
export async function previewTrackerReview(repo: Repo, id: string): Promise<ImportReviewPreview> {
  const row = (await repo.listImportReviews()).find((x) => x.sourceId === id);
  if (!row) throw new HttpError(404, 'Tracker row not found');
  const [settings, reps, context] = await Promise.all([repo.getSettings(), repo.listReps(), repo.loadContext()]);
  const r = verifiedTerms(row.source, row.review.terms);
  const problems = [...trackerIssues(r, settings, reps)];
  if (row.status !== 'reviewed') problems.push('Mark this row reviewed before importing.');
  if (row.sourceId.includes(':duplicate:')) problems.push('Duplicate source Deal ID; correct the staged export before committing.');
  const isDraw = !!r.parent && r.parent !== r.id;
  const existing = context.deals.find((d) => d.id === (isDraw ? r.parent : r.id));
  if (isDraw && !existing) problems.push(`Import parent ${r.parent} before its draw.`);
  const lender = settings.lenders.find((x) => x.name.toLowerCase() === r.lender.toLowerCase());
  const product = settings.products.find((x) => x.name.toLowerCase() === r.product.toLowerCase());
  const partner = settings.partners.find((x) => x.name.toLowerCase() === r.referralPartner.toLowerCase());
  if (r.dealStatus && !settings.lists.dealStatuses.includes(r.dealStatus)) problems.push(`Unknown confirmed deal status "${r.dealStatus}".`);
  if (r.referralPartner && !partner) problems.push(`Unknown confirmed referral partner "${r.referralPartner}".`);
  if (r.referralFee !== null && r.referralFee > (r.gross ?? 0)) problems.push('Confirmed referral fee exceeds gross commission.');
  if (partner && r.referralFee === null) problems.push('Verify the historical referral fee; current partner settings are not historical evidence.');
  if (!partner && r.referralFee && r.referralFee > 0) problems.push('A historical referral fee needs a confirmed referral partner.');
  const psfBasis = product?.basis === 'payback' && r.factor ? r.amount * r.factor : r.amount;
  const psfRate = r.psf !== null && r.psf <= 100 ? (r.psf > 1 ? r.psf / 100 : r.psf)
    : r.psfDollars !== null && psfBasis ? r.psfDollars / psfBasis : r.psf && psfBasis ? r.psf / psfBasis : 0;
  if (r.psf !== null && r.psfDollars !== null && Math.abs(money(r.psf > 100 ? r.psf : psfBasis * psfRate) - r.psfDollars) > .01)
    problems.push('Confirmed PSF rate and dollars disagree.');
  const repRecord = (name: string) => reps.find((x) => x.name.toLowerCase() === name.toLowerCase());
  const rep = (name: string) => repRecord(name)?.id ?? null;
  // Never mutate the repository's read snapshot while constructing a preview
  // (the memory repo returns domain objects by reference).
  let deal: Deal | null = existing ? structuredClone(existing) : null;
  let draw: DealDraw | null = null;
  const roleRate = (name: string, rate: number | null, dollars: number | null) => {
    if (!name) return 0;
    if (rate !== null) return rate;
    if (dollars !== null && r.gross && r.gross > 0) return Math.round(dollars / r.gross * 100000) / 100000;
    problems.push(`Verify the ${name} role rate or role dollars; roster defaults cannot establish historical terms.`);
    return 0;
  };
  if (!existing && !isDraw && lender && product && r.business && r.date && r.amount > 0) {
    try {
      deal = priceDeal({ business: r.business, fundedDate: r.date, lender: lender.name, product: product.name, amount: r.amount,
        termDays: r.termDays, factor: r.factor, frequency: r.frequency, commRate: r.commRate,
        openerId: rep(r.opener), closerId: rep(r.closer), overrideId: rep(r.override),
        openerRate: roleRate(r.opener, r.openerRate, r.openerDollars), closerRate: roleRate(r.closer, r.closerRate, r.closerDollars),
        overrideRate: roleRate(r.override, r.overrideRate, r.overrideDollars), referralPartner: r.referralPartner || null,
        psfPct: psfRate,
        leadSource: r.leadSource || 'Historical import', notes: r.notes || null },
        { id: r.id, today: new Date().toISOString().slice(0, 10), rule: product, lender,
          partner: partner && r.referralFee !== null && r.gross ? { ...partner, pct: r.referralFee / r.gross, monthlyCap: null } : partner });
      if (r.dealStatus && settings.lists.dealStatuses.includes(r.dealStatus)) deal.dealStatus = r.dealStatus;
    } catch (e) { problems.push(e instanceof Error ? e.message : 'Deal terms could not be priced'); }
  }
  if (deal && isDraw) {
    if (r.psf || r.psfDollars) problems.push('Draw PSF cannot be stored separately; reconcile its fee with the parent facility.');
    if (existing!.lender.toLowerCase() !== r.lender.toLowerCase() || !product?.parent) problems.push('Draw lender or product is not compatible with the parent facility.');
    if (!settings.products.find((p) => p.name.toLowerCase() === existing!.product.toLowerCase())?.multiDraw) problems.push('Parent facility does not support draws.');
    if (r.commRate === null) problems.push('A draw requires a verified commission rate.');
    else {
      try {
        draw = newDraw(deal, { amount: r.amount, date: r.date, commRate: r.commRate > 1 ? r.commRate / 100 : r.commRate,
          partner: settings.partners.find((p) => p.name.toLowerCase() === deal!.referralPartner?.toLowerCase()) ?? null,
          termDays: r.termDays, factor: r.factor, frequency: r.frequency });
        deal.draws.push(draw);
      } catch (e) { problems.push(e instanceof Error ? e.message : 'Draw terms could not be priced'); }
    }
  }
  const target = deal && (isDraw ? draw : segmentOf(deal, 'base'));
  if (deal && target) {
    if (r.gross !== null && Math.abs(target.gross - r.gross) > .01) problems.push(`Calculated gross ${target.gross} does not match source gross ${r.gross}.`);
    if (r.gross === null) problems.push('Verify the exact gross commission before import.');
    if (r.referralFee !== null && Math.abs(target.referralFee - r.referralFee) > .01) problems.push(`Calculated referral fee ${target.referralFee} differs from confirmed ${r.referralFee}.`);
    if (r.psfDollars !== null && !isDraw && Math.abs(money((product?.basis === 'payback' ? deal.payback ?? deal.funded : deal.funded) * deal.psfPct) - r.psfDollars) > .01) problems.push('Calculated PSF differs from confirmed dollars.');
    if (r.openerDollars !== null && deal.openerId && Math.abs(money(target.gross * deal.openerRate) - r.openerDollars) > .01) problems.push('Opener split does not match verified source dollars.');
    if (r.closerDollars !== null && deal.closerId && Math.abs(money(target.gross * deal.closerRate) - r.closerDollars) > .01) problems.push('Closer split does not match verified source dollars.');
    if (r.overrideDollars !== null && deal.overrideId && Math.abs(money(target.gross * deal.overrideRate) - r.overrideDollars) > .01) problems.push('Override split does not match verified source dollars.');
    const reviewed = row.review;
    if (reviewed.lender === 'paid' && reviewed.lenderAmount !== null) {
      if (target.schedule) {
        if (reviewed.lenderWeeks === null) problems.push('Confirm the exact number of lender receipt weeks.');
        else if (reviewed.lenderWeeks === 0 && reviewed.lenderAmount > 0) problems.push('A positive scheduled receipt requires at least one confirmed week.');
        else if (reviewed.lenderWeeks > target.schedule.weeks || reviewed.lenderWeeks < target.schedule.received) problems.push('Lender weeks exceed the schedule or reduce live receipts.');
        else {
          const patch = recordWeek(target, reviewed.lenderWeeks - target.schedule.received, reviewed.lenderDate!, 'historical');
          if (money(collectedOf(patch ? { ...target, ...patch } : target)) !== reviewed.lenderAmount) problems.push('Receipt amount differs from the scheduled weeks.');
          if (patch) {
            if (isDraw) Object.assign(draw!, patch);
            else Object.assign(deal, { commSchedule: patch.schedule, commCollected: patch.collected });
          }
        }
      } else {
        if (reviewed.lenderWeeks !== null) problems.push('Lender weeks only apply to scheduled receipts.');
        if (reviewed.lenderAmount > target.gross + .005) problems.push('Receipt exceeds calculated gross.');
        if (isDraw) draw!.collected = reviewed.lenderAmount;
        else deal.commCollected = reviewed.lenderAmount;
      }
      if (!isDraw) deal.lenderPaid = reviewed.lenderDate;
    } else if (reviewed.lenderWeeks !== null) problems.push('Clear lender weeks without a confirmed receipt.');
    if (existing && !isDraw) {
      if (existing.business !== r.business || existing.date !== r.date || Math.abs(existing.funded - r.amount) > .01
        || existing.lender.toLowerCase() !== r.lender.toLowerCase() || existing.product.toLowerCase() !== r.product.toLowerCase()
        || (r.commRate !== null && Math.abs(existing.commRate - (r.commRate > 1 ? r.commRate / 100 : r.commRate)) > .00001))
        problems.push('Existing live deal terms do not match the reviewed source.');
      if (r.dealStatus && existing.dealStatus !== r.dealStatus) problems.push('Existing deal status differs from reviewed status.');
      if ((existing.referralPartner ?? '').toLowerCase() !== r.referralPartner.toLowerCase()) problems.push('Existing referral partner differs from reviewed partner.');
      if ((r.psf !== null || r.psfDollars !== null) && Math.abs(existing.psfPct - psfRate) > .00001) problems.push('Existing deal PSF rate differs from reviewed rate.');
      const liveReceived = collectedOf(segmentOf(existing, 'base')!);
      if (reviewed.lender === 'paid' && Math.abs(liveReceived - reviewed.lenderAmount!) > .005
        || reviewed.lender === 'unpaid' && liveReceived > .005)
        problems.push(`Existing lender receipts ${liveReceived} differ from reviewed ${reviewed.lenderAmount ?? 0}; reconcile live deal first.`);
      if (reviewed.lender === 'paid' && existing.lenderPaid && existing.lenderPaid !== reviewed.lenderDate) problems.push('Existing receipt date differs from reviewed date.');
    }
  }
  const payouts: ImportReviewPreview['payouts'] = [];
  if (deal) {
    const candidates = dealLines(deal).filter((l) => l.segmentKey === (draw?.ref ?? 'base'));
    const assigned = new Map<string, number>();
    const grouped = new Map<string, ImportReviewPreview['payouts']>();
    for (const p of row.review.repPayments) {
      const line = candidates.find((l) => l.repId === p.repId && l.role === p.role && (assigned.get(l.key) ?? 0) + p.amount <= l.amount + .005);
      if (!line) { problems.push(`Payment ${p.repId}/${p.role}/${p.amount} exceeds or duplicates its role or scheduled unit.`); continue; }
      assigned.set(line.key, money((assigned.get(line.key) ?? 0) + p.amount));
      const entries = grouped.get(line.key) ?? [];
      entries.push({ ...p, key: '', alreadyPosted: false });
      grouped.set(line.key, entries);
    }
    const standing = standingLines(context.lines);
    const existingKeys = new Set(context.lines.map((l) => l.key));
    for (const line of candidates) {
      const entries = grouped.get(line.key) ?? [];
      const expectedBases = entries.map((p, i) => entries.length === 1 && Math.abs(p.amount - line.amount) <= .005
        ? line.key : `${line.key}|historical-partial${i ? `:${i + 1}` : ''}`);
      const belongs = (key: string) => rowBase(key) === line.key || rowBase(key).startsWith(`${line.key}|historical-partial`);
      for (const actual of standing.filter((x) => belongs(x.key))) {
        if (!expectedBases.includes(rowBase(actual.key)))
          problems.push(`Live payment ${actual.key} is not among the verified installments; reconcile before committing.`);
      }
      for (const [i, p] of entries.entries()) {
        const base = expectedBases[i]!;
        const matches = standing.filter((x) => rowBase(x.key) === base);
        if (matches.length > 1 || matches.some((x) => x.repId !== p.repId || x.role !== p.role || Math.abs(x.amount - p.amount) > .005 || x.paidAt !== p.paidAt))
          problems.push(`Live payment ${base} differs in payee, amount or date; reconcile before committing.`);
        payouts.push({ ...p, key: matches[0]?.key ?? nextRowKey(base, existingKeys), alreadyPosted: matches.length > 0 });
      }
    }
    if (row.review.reps === 'unpaid' && candidates.some((l) => standing.some((x) => rowBase(x.key) === l.key || rowBase(x.key).startsWith(`${l.key}|historical-partial`)))) problems.push('Live ledger records payments but review says unpaid.');
  }
  if (row.review.reps === 'paid' && !row.review.repPayments.length) problems.push('Identify each previously paid rep and amount.');
  if (r.clawbackAmount && !r.clawbackDate) problems.push('Confirm the actual clawback date; the funding date is not a substitute.');
  const clawback: Clawback | null = deal && r.clawbackAmount && r.clawbackDate ? { id: `cb-${deal.id.toLowerCase()}-${isDraw ? draw?.ref.toLowerCase() : 'base'}-historical`, dealId: deal.id, date: r.clawbackDate, amount: r.clawbackAmount, recovered: 0, reason: 'Historical import', status: 'open' } : null;
  if (clawback && context.clawbacks.some((x) => x.id === clawback.id || x.dealId === clawback.dealId && x.date === clawback.date && x.amount === clawback.amount)) problems.push('This clawback already exists.');
  if (clawback && deal) clawback.status = clawbackStatus(clawback, deal, context.lines);
  const action = problems.length ? 'blocked' : isDraw ? 'draw' : existing ? 'existing' : 'new';
  return { sourceId: id, revision: row.revision, action, deal, draw, receipt: row.review.lender === 'paid' && row.review.lenderAmount !== null && row.review.lenderDate ? { amount: row.review.lenderAmount, paidAt: row.review.lenderDate } : null, payouts, clawback, problems, previewToken: reviewToken(row, context, settings, reps) };
}

/** Commit only the exact reviewed snapshot. Existing deals are never overwritten. */
export async function commitTrackerReview(repo: Repo, id: string, revision: number, previewToken: string, actorRepId: string) {
  if (!Number.isInteger(revision) || !previewToken) throw new HttpError(400, 'Preview and revision are required.');
  try {
    return await repo.commitReviewedImport(id, revision, async (locked) => {
      const preview = await previewTrackerReview(locked, id);
      if (preview.revision !== revision || preview.previewToken !== previewToken) throw new HttpError(409, 'The reviewed source, live deal or ledger changed; preview again.');
      if (preview.problems.length) throw new HttpError(409, preview.problems.join('; '));
      const lines: PayoutLine[] = preview.payouts.filter((p) => !p.alreadyPosted).map((p) => ({
        key: p.key, dealId: preview.deal!.id, segmentKey: preview.draw?.ref ?? 'base',
        role: p.role as PayoutLine['role'], repId: p.repId, amount: p.amount,
        runId: null, clawbackId: null, paidAt: p.paidAt,
      }));
      return { ...preview, expectedToken: previewToken, lines };
    }, actorRepId);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && (/Staged review|preview token|changed while committing|duplicate key|serialization|could not serialize/i).test(error.message))
      throw new HttpError(409, 'This import changed while committing. Preview again before retrying.');
    throw error;
  }
}