import { createHash } from 'node:crypto';
import { lenderSupportsProduct } from '@greystone/commission';
import { readFundedDealsCsv, type SheetRow } from '@greystone/db/seed/csv';
import { HttpError } from '../http-error.js';
import type { ImportReview, ImportReviewDecision, Repo } from '../repo.js';

const money = (n: number) => Math.round(n * 100) / 100;
const validDate = (value: string | null) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
  && value <= new Date().toISOString().slice(0, 10);
type Terms = NonNullable<ImportReviewDecision['terms']>;
const textFields = ['parent', 'business', 'lender', 'product', 'frequency', 'referralPartner', 'opener', 'closer', 'override', 'dealStatus', 'notes', 'leadSource'] as const;
const dateFields = ['date', 'clawbackDate'] as const;
const numberFields = ['amount', 'factor', 'termDays', 'commRate', 'psf', 'psfDollars', 'gross', 'referralFee', 'totalRepPayout', 'openerRate', 'openerDollars', 'closerRate', 'closerDollars', 'overrideRate', 'overrideDollars', 'clawbackAmount'] as const;
const allowedFields = new Set<string>([...textFields, ...dateFields, ...numberFields]);

function verifiedTerms(source: SheetRow, terms: Terms | undefined): SheetRow {
  return { ...source, ...terms };
}

/** Sheet facts are suggestions, not verified financial entries. Explicit confirmation is still required. */
export function suggestedReview(source: SheetRow, saved: ImportReviewDecision, status: ImportReview['status']): ImportReviewDecision {
  if (status !== 'not_reviewed' && !(status === 'needs_attention'
    && !saved.termsConfirmed && saved.lender === 'unknown' && saved.reps === 'unknown' && !saved.notes && !saved.terms)) return saved;
  const repAmount = source.totalRepPayout && source.totalRepPayout > 0
    ? source.totalRepPayout
    : money((source.openerDollars ?? 0) + (source.closerDollars ?? 0) + (source.overrideDollars ?? 0)) || null;
  return {
    ...saved,
    lender: source.lenderPaid ? 'paid' : source.commissionStatus.toLowerCase().includes('waiting') ? 'unpaid' : 'unknown',
    lenderAmount: source.lenderPaid ? source.gross : null,
    lenderDate: source.lenderPaid || null,
    reps: source.repPaid ? 'paid' : 'unpaid',
    repAmount: source.repPaid ? repAmount : null,
    repDate: source.repPaid || null,
  };
}

function validateTerms(input: unknown): asserts input is Terms {
  if (input === undefined) return;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid corrected deal fields');
  const fields = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (!allowedFields.has(key)) throw new HttpError(400, `Deal field "${key}" cannot be edited here`);
    if ((textFields as readonly string[]).includes(key) && (typeof value !== 'string' || value.length > 2000))
      throw new HttpError(400, `Invalid ${key}`);
    if ((dateFields as readonly string[]).includes(key) && (typeof value !== 'string' || (value !== '' && !validDate(value))))
      throw new HttpError(400, `Invalid ${key} date`);
    if ((numberFields as readonly string[]).includes(key)
      && !(value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000_000)))
      throw new HttpError(400, `Invalid ${key} amount or rate`);
  }
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
  if (row.totalRepPayout !== null && row.gross !== null && row.totalRepPayout > row.gross - (row.referralFee ?? 0) + 0.01)
    issues.push('Rep payout exceeds gross commission minus referral fee');
  if (row.gross !== null && row.commRate !== null && row.amount > 0) {
    const predicted = money(row.amount * (row.commRate > 1 ? row.commRate / 100 : row.commRate) + (row.psfDollars ?? 0));
    if (Math.abs(predicted - row.gross) > 1) issues.push(`Sheet gross ${money(row.gross)} differs from amount × commission rate + PSF (${predicted})`);
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
    review: suggestedReview(row.source, row.review, row.status),
    issues: [...(row.sourceId.includes(':duplicate:') ? [`Deal ID ${row.source.id} is duplicated in this sheet. Correct the IDs before using either row for a live import.`] : []), ...trackerIssues(verifiedTerms(row.source, row.review.terms), settings, reps)],
    alreadyInPortal: existing.has(row.source.id),
  }));
}

export async function saveTrackerReview(repo: Repo, id: string, revision: number, input: ImportReviewDecision, status: ImportReview['status'], actorRepId: string) {
  const current = (await repo.listImportReviews()).find((x) => x.sourceId === id);
  if (!current) throw new HttpError(404, 'Tracker row not found');
  if (current.revision !== revision) throw new HttpError(409, 'This row changed in another session. Refresh to see the latest review before saving.');
  if (!['not_reviewed', 'in_progress', 'needs_attention', 'reviewed'].includes(status)) throw new HttpError(400, 'Invalid review status');
  if (typeof input?.termsConfirmed !== 'boolean' || !['unknown', 'unpaid', 'paid'].includes(input.lender)
    || !['unknown', 'unpaid', 'paid'].includes(input.reps) || typeof input.notes !== 'string' || input.notes.length > 2000) throw new HttpError(400, 'Invalid review answers');
  validateTerms(input.terms);
  const corrected = verifiedTerms(current.source, input.terms);
  if (corrected.parent && (!/^F\d+$/.test(corrected.parent) || corrected.parent === corrected.id))
    throw new HttpError(400, 'Parent deal ID must name a different valid deal');
  if (corrected.amount <= 0 || !validDate(corrected.date)) throw new HttpError(400, 'Enter a positive funding amount and a valid funded date');
  if (corrected.commRate !== null && corrected.commRate > 100) throw new HttpError(400, 'Commission rate must not exceed 100%');
  if (corrected.termDays !== null && !Number.isInteger(corrected.termDays)) throw new HttpError(400, 'Term must be a whole number of days');
  for (const rate of [corrected.openerRate, corrected.closerRate, corrected.overrideRate, corrected.psf])
    if (rate !== null && rate > 100) throw new HttpError(400, 'Role and PSF rates must not exceed 100%');
  const amount = (n: unknown) => n === null || (typeof n === 'number' && Number.isFinite(n) && n > 0 && money(n) === n);
  if (!amount(input.lenderAmount) || !amount(input.repAmount)) throw new HttpError(400, 'Amounts must be positive dollars and cents');
  if (input.lender === 'paid' && (!input.lenderAmount || !validDate(input.lenderDate))) throw new HttpError(400, 'Enter the lender amount received and its actual date');
  if (input.reps === 'paid' && (!input.repAmount || !validDate(input.repDate))) throw new HttpError(400, 'Enter the amount actually paid to reps and its actual date');
  if (input.lender !== 'paid' && (input.lenderAmount !== null || input.lenderDate !== null)
    || input.reps !== 'paid' && (input.repAmount !== null || input.repDate !== null)) throw new HttpError(400, 'Clear payment amounts and dates for unpaid or unknown answers');
  if (input.lenderAmount && corrected.gross !== null && input.lenderAmount > corrected.gross + 0.01) throw new HttpError(400, 'Lender receipt exceeds the confirmed gross commission; correct the terms or receipt');
  if (input.repAmount && corrected.totalRepPayout !== null && input.repAmount > corrected.totalRepPayout + 0.01) throw new HttpError(400, 'Rep payment exceeds the confirmed total rep payout; correct the terms or payment');
  if (status === 'reviewed') {
    if (!input.termsConfirmed || input.lender === 'unknown' || input.reps === 'unknown') throw new HttpError(400, 'Confirm terms and both payment answers before marking reviewed');
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