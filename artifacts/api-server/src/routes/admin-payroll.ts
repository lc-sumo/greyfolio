import { Router } from 'express';
import { HttpError, currentUser, requireRole } from '../auth/middleware.js';
import { payableFor, payrollRepDetail, payrollReps, preview, runCsv, runSummary } from '../payroll-views.js';
import type { Repo } from '../repo.js';
import { advanceRun, createRun, paySelected } from '../services/payroll.js';

/** Payroll: runs, per-rep payable lines, netting preview, pay + record, CSV. Admin only. */
export function adminPayrollRouter(repo: Repo): Router {
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
    res.json(await advanceRun(repo, String(req.params.id), currentUser(req)!.repId));
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

  r.get('/payroll/runs/:id/export.csv', async (req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    const repId = typeof req.query.rep === 'string' ? req.query.rep : undefined;
    res.type('text/csv').attachment(`${String(req.params.id)}${repId ? `-${repId}` : ''}.csv`).send(runCsv(ctx, reps, String(req.params.id), repId));
  });

  r.get('/payroll/payable/:repId', async (req, res) => {
    const ctx = await repo.loadContext();
    res.json({ lines: payableFor(ctx, String(req.params.repId)) });
  });

  return r;
}
