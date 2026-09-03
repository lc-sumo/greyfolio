import { PayoutError, applyPayout, planPayout, type PayoutPlan, type PayrollRun } from '@greystone/commission';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';

const today = () => new Date().toISOString().slice(0, 10);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function label(start: string, end: string): string {
  const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number];
  const [, em, ed] = end.split('-').map(Number) as [number, number, number];
  return `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}, ${sy}`;
}
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The twice-monthly period that follows `after` (or contains `on` when there are no runs). */
export function nextPeriod(runs: PayrollRun[], on = today()): { start: string; end: string } {
  const latest = [...runs].sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!latest) {
    const [y, m, d] = on.split('-').map(Number) as [number, number, number];
    return d <= 15 ? { start: iso(y, m, 1), end: iso(y, m, 15) } : { start: iso(y, m, 16), end: iso(y, m, lastDay(y, m)) };
  }
  const [y, m, d] = latest.end.split('-').map(Number) as [number, number, number];
  if (d <= 15) return { start: iso(y, m, 16), end: iso(y, m, lastDay(y, m)) };
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { start: iso(ny, nm, 1), end: iso(ny, nm, 15) };
}

export async function createRun(repo: Repo, actorRepId: string, period?: { start: string; end: string }): Promise<PayrollRun> {
  const runs = await repo.listRuns();
  const p = period ?? nextPeriod(runs);
  if (p.start > p.end) throw new HttpError(400, 'Run start must not be after its end');
  if (runs.some((r) => r.start <= p.end && r.end >= p.start)) throw new HttpError(400, `A run already covers ${label(p.start, p.end)}`);
  const run: PayrollRun = { id: `run-${p.start}`, label: label(p.start, p.end), start: p.start, end: p.end, status: 'draft' };
  await repo.insertRun(run);
  await repo.writeAudit({ actorRepId, action: 'payroll.run', targetRepId: null, path: `/api/admin/payroll/runs/${run.id}`, detail: { created: run.label } });
  return run;
}

/** draft → approved → paid. Approval releases statements to reps (and, in Phase 9, the QuickBooks queue). */
export async function advanceRun(repo: Repo, id: string, actorRepId: string): Promise<PayrollRun> {
  const run = (await repo.listRuns()).find((r) => r.id === id);
  if (!run) throw new HttpError(404, `Run ${id} not found`);
  if (run.status === 'paid') throw new HttpError(400, `${run.label} is already paid and locked`);
  const next = run.status === 'draft' ? 'approved' : 'paid';
  await repo.updateRun(id, { status: next, ...(next === 'approved' ? { approvedAt: new Date().toISOString() } : { paidAt: new Date().toISOString() }) });
  await repo.writeAudit({ actorRepId, action: 'payroll.run', targetRepId: null, path: `/api/admin/payroll/runs/${id}`, detail: { status: next } });
  return { ...run, status: next };
}

export interface PayRequest {
  runId: string;
  repId: string;
  selectedKeys: string[];
}

/**
 * Pay selected lines: plan through the domain (ledger rows, oldest-first
 * recovery rows, repPaid stamps), commit in one transaction, audit it.
 * The response echoes `repId` so the client pins the rep it just paid.
 */
export async function paySelected(repo: Repo, req: PayRequest, actorRepId: string): Promise<PayoutPlan> {
  const runs = await repo.listRuns();
  const run = runs.find((r) => r.id === req.runId);
  if (!run) throw new HttpError(404, `Run ${req.runId} not found`);
  if (run.status === 'paid') throw new HttpError(400, `${run.label} is paid and locked — open a new run`);
  const rep = await repo.findRep(req.repId);
  if (!rep) throw new HttpError(404, `Rep ${req.repId} not found`);
  const ctx = await repo.loadContext();
  let plan: PayoutPlan;
  try {
    plan = planPayout(ctx, { repId: req.repId, selectedKeys: req.selectedKeys, runId: run.id, paidAt: today() });
  } catch (e) {
    if (e instanceof PayoutError) throw new HttpError(400, e.message);
    throw e;
  }
  // Sanity: applying the plan must leave the ledger consistent before we write it.
  applyPayout(ctx, plan);
  await repo.commitPayout({ lines: [...plan.lines, ...plan.recoveries], clawbackUpdates: plan.clawbackUpdates, dealsFullyPaid: plan.dealsFullyPaid, paidAt: today() });
  await repo.writeAudit({ actorRepId, action: 'payroll.pay', targetRepId: req.repId, path: `/api/admin/payroll/runs/${run.id}/pay`, detail: { lines: plan.lines.length, gross: plan.gross, withheld: plan.withheld, net: plan.net } });
  return plan;
}
