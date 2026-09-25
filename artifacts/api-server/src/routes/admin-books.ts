import { Router } from 'express';
import { currentUser, requireRole } from '../auth/middleware.js';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';
import { booksCsv, cashView, exceptions, markPartnerPaid, partnerPayables, receivables, receiveLenderPayment, repPayablesAging } from '../services/books.js';
import { addRepFile, fetchRepFile, removeRepFile } from '../services/notes.js';
import { scorecards } from '../services/scorecards.js';
import { cents, SYSTEM_CHART } from '@greystone/commission';
import { balanceSheet, directCashFlow, profitAndLoss, repPayables, trialBalance } from '../services/accounting.js';

const today = () => new Date().toISOString().slice(0, 10);

/** Bookkeeping: receivables, partner payables, the cash view and its export, exceptions; rep files. Admin only. */
export function adminBooksRouter(repo: Repo): Router {
  const r = Router();
  r.use(requireRole('admin'));
  const actor = (req: Parameters<Router>[0]) => currentUser(req)!.repId;
  const yearOf = (req: Parameters<Router>[0]) => {
    const y = Number(req.query.year ?? new Date().getUTCFullYear());
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, 'year must be a four-digit year');
    return y;
  };
  const codes = new Set(SYSTEM_CHART.map((x) => x.code));
  const iso = (value: unknown, label = 'date') => { const s = String(value ?? ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new HttpError(400, `${label} must be YYYY-MM-DD`); return s; };
  const code = (value: unknown) => { const s = String(value ?? ''); if (!codes.has(s as typeof SYSTEM_CHART[number]['code'])) throw new HttpError(400, 'Unknown account code'); return s; };
  const finite = (value: unknown, label: string) => { const n = Number(value); if (!Number.isFinite(n)) throw new HttpError(400, `${label} must be a finite number`); return n; };
  const reportRange = (req: Parameters<Router>[0]) => ({ from: req.query.from ? iso(req.query.from, 'from') : undefined, to: req.query.to ? iso(req.query.to, 'to') : undefined });

  r.get('/books/receivables', async (_req, res) => {
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    res.json(receivables(ctx, settings, today()));
  });
  /** "Received" on a receivable row: the lender's money landed, dated. */
  r.post('/books/receivables/receive', async (req, res) => {
    const result = await receiveLenderPayment(repo, req.body ?? {}, actor(req), today());
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    res.json({ ...result, receivables: receivables(ctx, settings, today()) });
  });
  /** What the house owes each rep, aged from the funded date. */
  r.get('/books/rep-aging', async (_req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    res.json(repPayablesAging(ctx, reps, today()));
  });
  r.get('/books/partners', async (_req, res) => {
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    res.json(partnerPayables(ctx, settings));
  });
  r.post('/books/partners/pay', async (req, res) => res.json(await markPartnerPaid(repo, req.body ?? {}, actor(req))));
  r.get('/books/cash', async (req, res) => res.json(cashView(await repo.loadContext(), yearOf(req))));
  r.get('/books/cash.csv', async (req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    const y = yearOf(req);
    res.type('text/csv').attachment(`books-${y}.csv`).send(booksCsv(ctx, reps, y));
  });
  r.get('/books/exceptions', async (_req, res) => {
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    res.json(exceptions(ctx, settings, today()));
  });
  /* Serialization is acquired before the repository reads its operational
     snapshot. This prevents an older request from correcting newer facts. */
  r.post('/books/sync', async (req, res) => {
    const result = await repo.syncAccounting(null, today());
    await repo.writeAudit({ actorRepId: actor(req), action: 'books.sync', targetRepId: null, path: req.path, detail: { ...result } });
    res.json(result);
  });
  r.get('/books/journals', async (req, res) => { const q = reportRange(req); res.json({ journals: await repo.listJournals({ ...q, accountCode: req.query.accountCode ? code(req.query.accountCode) : undefined, sourceKey: req.query.sourceKey ? String(req.query.sourceKey) : undefined }) }); });
  r.get('/books/reports/trial-balance', async (req, res) => { const q = reportRange(req); res.json(trialBalance(await repo.listJournals(), q.from, q.to)); });
  r.get('/books/reports/profit-loss', async (req, res) => { const q = reportRange(req); res.json(profitAndLoss(await repo.listJournals(), q.from, q.to)); });
  r.get('/books/reports/balance-sheet', async (req, res) => res.json(balanceSheet(await repo.listJournals(), req.query.asOf ? iso(req.query.asOf, 'asOf') : undefined)));
  r.get('/books/reports/cash-flow', async (req, res) => { const q = reportRange(req); res.json(directCashFlow(await repo.listJournals(), q.from, q.to)); });
  r.get('/books/reports/rep-payables', async (req, res) => res.json(repPayables(await repo.listJournals(), req.query.asOf ? iso(req.query.asOf, 'asOf') : undefined)));
  r.get('/books/periods', async (_req, res) => res.json({ periods: await repo.listAccountingPeriods() }));
  r.post('/books/periods', async (req, res) => { const start = iso(req.body?.start, 'start'); const end = iso(req.body?.end, 'end'); if (start > end) throw new HttpError(400, 'start must be on or before end'); const p = await repo.createAccountingPeriod({ start, end }); await repo.writeAudit({ actorRepId: actor(req), action: 'books.period.create', targetRepId: null, path: req.path }); res.status(201).json(p); });
  r.post('/books/periods/:id/close', async (req, res) => { let result; try { result = await repo.closeAccountingPeriod(String(req.params.id), actor(req)); } catch (e) { throw new HttpError(/No accounting period|not found/.test(String(e)) ? 404 : 400, String(e).replace(/^Error: /, '')); } await repo.writeAudit({ actorRepId: actor(req), action: 'books.period.close', targetRepId: null, path: req.path, detail: result.checklist }); res.json(result); });
  r.post('/books/periods/:id/reopen', async (req, res) => { try { await repo.reopenAccountingPeriod(String(req.params.id), actor(req)); } catch (e) { throw new HttpError(/No accounting period|not found/.test(String(e)) ? 404 : 400, String(e).replace(/^Error: /, '')); } await repo.writeAudit({ actorRepId: actor(req), action: 'books.period.reopen', targetRepId: null, path: req.path }); res.json({ ok: true }); });
  const reconciliationView = (x: Awaited<ReturnType<Repo['findReconciliation']>>) => {
    if (!x) return x;
    const clearedAmount = cents(x.matches.reduce((n, m) => n + m.amount, 0));
    const expectedBalance = cents(x.openingBalance + clearedAmount);
    return { ...x, clearedAmount, expectedBalance, difference: cents(x.statementBalance - expectedBalance) };
  };
  r.get('/books/reconciliations', async (_req, res) => res.json({ reconciliations: (await repo.listReconciliations()).map((x) => reconciliationView(x)) }));
  r.get('/books/reconciliations/:id', async (req, res) => { const x = reconciliationView(await repo.findReconciliation(String(req.params.id))); if (!x) throw new HttpError(404, 'Reconciliation not found'); res.json(x); });
  r.get('/books/reconciliations/:id/eligible-lines', async (req, res) => {
    const reconciliation = await repo.findReconciliation(String(req.params.id));
    if (!reconciliation) throw new HttpError(404, 'Reconciliation not found');
    if (reconciliation.status !== 'open') throw new HttpError(409, 'Reconciliation is not open');
    const used = new Set((await repo.listReconciliations()).flatMap((x) => x.matches.map((m) => m.journalLineId)));
    const lines = (await repo.listJournals({ to: reconciliation.statementDate, accountCode: code(reconciliation.accountCode) }))
      .flatMap((j) => j.lines.filter((l) => l.accountCode === reconciliation.accountCode && !used.has(l.id)).map((l) => ({ id: l.id, date: j.date, amount: l.debit - l.credit, sourceKey: j.sourceKey, label: `${j.date} · ${j.memo}` })));
    res.json({ accountCode: reconciliation.accountCode, statementStart: reconciliation.statementStart, statementDate: reconciliation.statementDate, lines });
  });
  r.post('/books/reconciliations', async (req, res) => {
    const statementStart = iso(req.body?.statementStart, 'statementStart');
    const statementDate = iso(req.body?.statementDate, 'statementDate');
    if (statementStart > statementDate) throw new HttpError(400, 'statementStart must be on or before statementDate');
    let x;
    try { x = await repo.createReconciliation({ accountCode: code(req.body?.accountCode), statementStart, statementDate, openingBalance: finite(req.body?.openingBalance, 'openingBalance'), statementBalance: finite(req.body?.statementBalance, 'statementBalance'), status: 'open', note: req.body?.note ? String(req.body.note) : null, createdBy: actor(req) }); } catch (e) { throw new HttpError(409, String(e).replace(/^Error: /, '')); }
    await repo.writeAudit({ actorRepId: actor(req), action: 'books.reconciliation', targetRepId: null, path: req.path });
    res.status(201).json(reconciliationView(x));
  });
  r.patch('/books/reconciliations/:id', async (req, res) => {
    const body = req.body ?? {};
    const unknown = Object.keys(body).filter((key) => key !== 'note' && key !== 'status');
    if (unknown.length) throw new HttpError(400, `Cannot update reconciliation field(s): ${unknown.join(', ')}`);
    if (body.status !== undefined && body.status !== 'completed') throw new HttpError(400, 'PATCH status may only transition open to completed');
    const patch = { ...(body.note !== undefined ? { note: body.note === null ? null : String(body.note) } : {}), ...(body.status ? { status: 'completed' as const } : {}) };
    try { await repo.updateReconciliation(String(req.params.id), patch); } catch (e) { throw new HttpError(409, String(e).replace(/^Error: /, '')); }
    await repo.writeAudit({ actorRepId: actor(req), action: 'books.reconciliation', targetRepId: null, path: req.path, detail: { fields: Object.keys(patch) } });
    res.json(reconciliationView(await repo.findReconciliation(String(req.params.id))));
  });
  r.post('/books/reconciliations/:id/reopen', async (req, res) => {
    try { await repo.reopenReconciliation(String(req.params.id)); } catch (e) { throw new HttpError(409, String(e).replace(/^Error: /, '')); }
    await repo.writeAudit({ actorRepId: actor(req), action: 'books.reconciliation', targetRepId: null, path: req.path, detail: { transition: 'completed->open' } });
    res.json(reconciliationView(await repo.findReconciliation(String(req.params.id))));
  });
  r.post('/books/reconciliations/:id/matches', async (req, res) => { const amount = finite(req.body?.amount, 'amount'); if (!amount) throw new HttpError(400, 'amount cannot be zero'); const id = String(req.params.id); try { await repo.matchReconciliation(id, { journalLineId: String(req.body?.journalLineId ?? ''), amount }); } catch (e) { throw new HttpError(400, String(e).replace(/^Error: /, '')); } await repo.writeAudit({ actorRepId: actor(req), action: 'books.reconciliation', targetRepId: null, path: req.path }); res.status(201).json(reconciliationView(await repo.findReconciliation(id))); });

  r.get('/scorecards', async (req, res) => {
    const [ctx, reps, teams, settings, tasks] = await Promise.all([repo.loadContext(), repo.listReps(), repo.listTeams(), repo.getSettings(), repo.listTasks()]);
    res.json({ year: yearOf(req), rows: scorecards(ctx, reps, teams, settings, tasks, yearOf(req), today()) });
  });

  /* ---- Rep files (W-9, agreements) ---- */
  const filesOf = async (repId: string) => {
    const [files, reps] = await Promise.all([repo.listRepFiles(repId), repo.listReps()]);
    const name = new Map(reps.map((x) => [x.id, x.name]));
    return files.map((f) => ({ ...f, uploadedByName: name.get(f.uploadedBy) ?? f.uploadedBy }));
  };
  r.get('/reps/:id/files', async (req, res) => res.json({ files: await filesOf(String(req.params.id)) }));
  r.post('/reps/:id/files', async (req, res) => {
    await addRepFile(repo, String(req.params.id), req.body ?? {}, actor(req));
    res.status(201).json({ files: await filesOf(String(req.params.id)) });
  });
  r.get('/reps/:id/files/:fileId', async (req, res) => {
    const f = await fetchRepFile(repo, String(req.params.id), String(req.params.fileId));
    res.setHeader('content-type', f.mime);
    res.setHeader('content-disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.name)}"`);
    res.setHeader('cache-control', 'private, max-age=0');
    res.send(Buffer.from(f.data, 'base64'));
  });
  r.delete('/reps/:id/files/:fileId', async (req, res) => {
    await removeRepFile(repo, String(req.params.id), String(req.params.fileId), actor(req));
    res.json({ files: await filesOf(String(req.params.id)) });
  });
  return r;
}
