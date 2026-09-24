import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppConfig } from '../config.js';
import type { Repo } from '../repo.js';
import { commitImport, previewImport } from '../services/import.js';
import { commitSyncRemittance, previewRemittance } from '../services/remittance.js';
import { FUNDED_DEALS_COLUMNS, type FundedDealsColumn } from '../../../../lib/db/src/seed/funded-deals-columns.js';
import { collectedOf, segments } from '@greystone/commission';

function sameSecret(actual: string | undefined, expected: string | null): boolean {
  if (!expected || !actual) return false;
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}
function csvBody(req: Request): string {
  if (typeof req.body === 'string') return req.body;
  if (typeof req.body?.csv === 'string') return req.body.csv;
  if (Array.isArray(req.body?.rows)) {
    return req.body.rows.map((r: unknown[]) => r.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  }
  throw new Error('Request must contain csv');
}

export function sheetsSyncRouter(repo: Repo, config: AppConfig): Router {
  const router = Router();
  router.use(async (req, res, next) => {
    if (!config.sheetsSyncSecret) return res.status(503).json({ error: 'Sheets sync is not configured' });
    if (!sameSecret(req.header('X-Sheets-Sync-Secret'), config.sheetsSyncSecret)) return res.status(401).json({ error: 'Invalid sheets sync secret' });
    const spreadsheetId = String(req.header('X-Sheets-Spreadsheet-Id') || '').trim();
    if (!/^[A-Za-z0-9_-]{6,200}$/.test(spreadsheetId)) return res.status(400).json({ error: 'A valid spreadsheet id is required' });
    try {
      const bound = await repo.getSetting<string>('sheetsSync.spreadsheetId');
      if (!bound) {
        if (!(await repo.claimSettingOnce('sheetsSync.spreadsheetId', spreadsheetId))) {
          const winner = await repo.getSetting<string>('sheetsSync.spreadsheetId');
          if (winner !== spreadsheetId) return res.status(403).json({ error: 'This sync secret is already bound to another spreadsheet' });
        }
      } else if (bound !== spreadsheetId) return res.status(403).json({ error: 'This sync secret is bound to another spreadsheet' });
      next();
    } catch (e) { next(e); }
  });
  const actor = async () => {
    const rep = await repo.findRepByEmail(config.superAdminEmail);
    if (!rep || !rep.active || rep.role !== 'admin') throw new Error('Sheets sync service actor is not an active admin');
    return rep;
  };
  async function idempotent(req: Request, operation: string, work: (actorId: string) => Promise<unknown>, res: Response) {
    const key = String(req.header('X-Sheets-Idempotency-Key') || req.body?.operationKey || '').trim();
    if (!key || key.length > 200) return res.status(400).json({ error: 'A stable operationKey is required' });
    const payloadHash = hash(req.body);
    try {
      const result = await repo.runSyncAtMostOnce(operation, key, payloadHash, async () => ({ status: 200, response: await work((await actor()).id) }));
      return res.status(result.status).json(result.response);
    } catch (e) {
      if (e instanceof Error && (e.message.includes('different payload') || e.message.includes('processing') || e.message.includes('uncertain'))) return res.status(409).json({ error: e.message });
      throw e;
    }
  }
  router.get('/master-deals', async (_req, res, next) => {
    try {
      const [{ deals }, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
      // A leading ' makes Sheets keep the cell as text, so a business name like "=HYPERLINK(...)" cannot become a formula.
      const plain = (v: string | null | undefined) => { const s = v ?? ''; return /^[=+@]/.test(s) ? `'${s}` : s; };
      const name = (id: string | null) => plain(reps.find((r) => r.id === id)?.name);
      const headers = FUNDED_DEALS_COLUMNS.map((c: FundedDealsColumn) => c.header || `Column ${c.col}`);
      const rows = deals.flatMap((d) => {
        const collected = segments(d).reduce((n, s) => n + collectedOf(s), 0);
        const status = collected >= d.gross + d.draws.reduce((n, x) => n + x.gross, 0) - 0.005 ? 'YES - Paid In Full' : collected > 0 ? 'Partially Paid' : 'NO';
        const values: Record<string, unknown> = {
          'Deal ID': d.id, 'Parent Deal': d.parentId ?? d.opportunityId, Date: d.date, 'Business Name': plain(d.business),
          Lender: plain(d.lender), Product: plain(d.product), 'Funded / Draw Amount ($)': d.funded, 'Factor Rate': d.factor ?? '',
          'Term (bus. days)': d.termDays ?? '', 'Payback ($)': d.payback ?? '', Frequency: d.frequency, 'Comm %': d.commRate,
          'PSF (% or $)': d.psfPct, 'PSF $ (auto)': '', 'Gross Commission ($)': d.gross,
          'Referral Partner': plain(d.referralPartner), 'Referral %': d.referralRate, 'Referral Fee ($)': d.referralFee,
          'Net Comm After Referral ($)': d.net, Opener: name(d.openerId), 'Opener %': d.openerRate,
          Closer: name(d.closerId), 'Closer %': d.closerRate, 'Override Rep': name(d.overrideId), 'Override %': d.overrideRate,
          'Clawback $': '', 'Clawback Date': '', 'Commission Status': status, 'Lender Paid Date': d.lenderPaid ?? '',
          'Rep Paid Date': d.repPaid ?? '', 'Deal Status': d.dealStatus, Notes: plain(d.notes), 'Lead Source': plain(d.leadSource),
        };
        const row = headers.map((h: string) => values[h] ?? '');
        const drawRows = d.draws.map((draw) => {
          const child = [...row];
          const set = (header: string, value: unknown) => { const i = headers.indexOf(header); if (i >= 0) child[i] = value ?? ''; };
          const drawCollected = draw.schedule ? (draw.schedule.received >= draw.schedule.weeks ? draw.gross : draw.schedule.received > 0 ? draw.gross / 2 : 0) : (draw.collected ?? 0);
          set('Deal ID', `${d.id}-${draw.ref}`); set('Parent Deal', d.id); set('Date', draw.date);
          set('Funded / Draw Amount ($)', draw.amount); set('Factor Rate', draw.factor ?? '');
          set('Term (bus. days)', draw.termDays ?? d.termDays ?? ''); set('Payback ($)', draw.payback ?? '');
          set('Comm %', draw.commRate); set('Gross Commission ($)', draw.gross); set('Referral Fee ($)', draw.referralFee);
          set('Net Comm After Referral ($)', draw.net);
          set('Commission Status', drawCollected >= draw.gross - 0.005 ? 'YES - Paid In Full' : drawCollected > 0 ? 'Partially Paid' : 'NO');
          return child;
        });
        return [row, ...drawRows];
      });
      res.json({ headers, rows, editableColumns: ['Deal Status', 'Lender Paid Date'], newDealInputColumns: FUNDED_DEALS_COLUMNS.filter((c: FundedDealsColumn) => c.kind === 'input').map((c: FundedDealsColumn) => c.header), portalOwnedColumns: FUNDED_DEALS_COLUMNS.filter((c: FundedDealsColumn) => c.kind !== 'input').map((c: FundedDealsColumn) => c.header) });
    } catch (e) { next(e); }
  });
  router.post('/master-deals', async (req, res, next) => {
    try {
      const csv = csvBody(req);
      if (csv.split(/\r?\n/).filter((line) => line.trim()).length <= 1) return res.json({ deals: 0, updated: 0, draws: 0, clawbacks: 0, payoutLines: 0, runId: null });
      const opts = { skipExisting: true, updateExisting: true };
      if (req.query.preview === 'true') return res.json(await previewImport(repo, csv, opts));
      return await idempotent(req, 'master-deals', (id) => commitImport(repo, csv, id, opts), res);
    } catch (e) { next(e); }
  });
  router.post('/remittance', async (req, res, next) => {
    try {
      const csv = csvBody(req);
      const key = String(req.header('X-Sheets-Idempotency-Key') || req.body?.operationKey || '').trim();
      if (!key || key.length > 200) return res.status(400).json({ error: 'A stable operationKey is required' });
      const payloadHash = hash(req.body);
      const prior = await repo.getSyncIdempotency('remittance', key);
      if (prior) {
        if (prior.payloadHash !== payloadHash) return res.status(409).json({ error: 'Idempotency key was used with a different payload' });
        if (prior.state === 'completed') return res.status(prior.status ?? 200).json(prior.response);
        return res.status(409).json({ error: `Sync operation is ${prior.state}; reconcile in the portal before retrying` });
      }
      const preview = await previewRemittance(repo, csv);
      if (req.query.preview === 'true') return res.json(preview);
      if (preview.summary.problems > 0 || Math.abs(preview.summary.unapplied) > 0.005) return res.status(400).json({ error: `Remittance must apply in full: ${preview.summary.problems} problem(s), ${preview.summary.unapplied.toFixed(2)} unapplied`, preview });
      return await idempotent(req, 'remittance', (id) => commitSyncRemittance(repo, csv, id), res);
    } catch (e) { next(e); }
  });
  router.get('/remittance/status', async (_req, res, next) => {
    try {
      const { deals, lines } = await repo.loadContext();
      res.json({ rows: deals.map((d) => ({ dealId: d.id, lenderPaid: d.lenderPaid, collected: d.commCollected ?? 0, gross: d.gross, applied: lines.filter((l) => l.dealId === d.id).reduce((n, l) => n + l.amount, 0) })) });
    } catch (e) { next(e); }
  });
  return router;
}