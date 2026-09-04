import { Router } from 'express';
import { HttpError, currentUser, requireRole } from '../auth/middleware.js';
import { annualCsv, annualReport, payableFor, payrollRepDetail, payrollReps, preview, runCsv, runSummary } from '../payroll-views.js';
import type { Repo } from '../repo.js';
import { advanceRun, createRun, deleteRun, paySelected, reopenRun, voidPayout } from '../services/payroll.js';
import { notifyRunApproved, type NotifyDeps } from '../services/notify.js';

/** Payroll: runs, per-rep payable lines, netting preview, pay + record, CSV. Admin only. */
export function adminPayrollRouter(repo: Repo, notify?: Omit<NotifyDeps, 'repo'>): Router {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/payroll', async (_req, res) => {
    const [ctx, reps, runs] = await Promise.all([repo.loadContext(), repo.listReps(), repo.listRuns()]);
    res.json({ runs: [...runs].sort((a, b) => b.start.localeCompare(a.start)).map((run) => runSummary(run, ctx)), reps: payrollReps(ctx, reps), outstanding: payrollReps(ctx, reps).reduce((s, x) => s + x.owed, 0) });
  });

  r.post('/payroll/runs', async (req, res) => {
    const period = req.body?.start && req.body?.end ? { start: String(req.body.start), end: String(req.body.end) } : undefined;
    res.status(201).json(await createRun(repo, currentUser(req)!.repId, period));
  });

  r.post('/payroll/runs/:id/advance', async (req, res) => {
    const actor = currentUser(req)!.repId;
    const run = await advanceRun(repo, String(req.params.id), actor);
    // Approval releases statements: each rep with lines in the run gets theirs by email when mail is on.
    const mailed = run.status === 'approved' && notify ? await notifyRunApproved({ repo, ...notify }, run.id, actor) : null;
    res.json({ ...run, notified: mailed ? mailed.sent : 0, statements: mailed ? mailed.reps : 0 });
  });

  r.post('/payroll/runs/:id/reopen', async (req, res) => {
    res.json(await reopenRun(repo, String(req.params.id), currentUser(req)!.repId));
  });
  r.delete('/payroll/runs/:id', async (req, res) => {
    res.json(await deleteRun(repo, String(req.params.id), currentUser(req)!.repId));
  });

  r.get('/payroll/runs/:id/reps/:repId', async (req, res) => {
    const [ctx, rep] = await Promise.all([repo.loadContext(), repo.findRep(String(req.params.repId))]);
    if (!rep) throw new HttpError(404, 'Rep not found');
    res.json(payrollRepDetail(ctx, rep, String(req.params.id)));
  });

  r.post('/payroll/preview', async (req, res) => {
    const ctx = await repo.loadContext();
    res.json(preview(ctx, String(req.body?.repId ?? ''), Array.isArray(req.body?.selectedKeys) ? req.body.selectedKeys.map(String) : []));
  });

  r.post('/payroll/runs/:id/pay', async (req, res) => {
    const plan = await paySelected(repo, { runId: String(req.params.id), repId: String(req.body?.repId ?? ''), selectedKeys: Array.isArray(req.body?.selectedKeys) ? req.body.selectedKeys.map(String) : [] }, currentUser(req)!.repId);
    res.status(201).json({ repId: plan.repId, runId: plan.runId, gross: plan.gross, withheld: plan.withheld, net: plan.net, lines: plan.lines.length, recoveries: plan.recoveries.length, dealsFullyPaid: plan.dealsFullyPaid, uncollectedDealIds: plan.uncollectedDealIds });
  });

  r.post('/payroll/runs/:id/void', async (req, res) => {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : undefined;
    const plan = await voidPayout(repo, { runId: String(req.params.id), repId: String(req.body?.repId ?? ''), keys }, currentUser(req)!.repId);
    res.json({ rows: plan.lines.length, reversed: plan.reversed, recoveriesReturned: plan.recoveriesReturned, dealsUnstamped: plan.dealsUnstamped });
  });
  r.get('/payroll/runs/:id/export.csv', async (req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    const repId = typeof req.query.rep === 'string' ? req.query.rep : undefined;
    res.type('text/csv').attachment(`${String(req.params.id)}${repId ? `-${repId}` : ''}.csv`).send(runCsv(ctx, reps, String(req.params.id), repId));
  });

  /** Year-end totals per rep (JSON and CSV). Defaults to the current year. */
  const yearOf = (req: Parameters<Router>[0]) => {
    const y = Number(req.query.year ?? new Date().getUTCFullYear());
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, 'year must be a four-digit year');
    return y;
  };
  r.get('/reports/annual', async (req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    res.json(annualReport(ctx, reps, yearOf(req)));
  });
  r.get('/reports/annual.csv', async (req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    const y = yearOf(req);
    res.type('text/csv').attachment(`rep-pay-${y}.csv`).send(annualCsv(ctx, reps, y));
  });

  r.get('/payroll/payable/:repId', async (req, res) => {
    const ctx = await repo.loadContext();
    res.json({ lines: payableFor(ctx, String(req.params.repId)) });
  });

  return r;
}
