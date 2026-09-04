import { PayoutError, VoidError, applyPayout, applyVoid, planPayout, planVoid, type PayoutPlan, type PayrollRun, type VoidPlan } from '@greystone/commission';
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
  const latest = [...runs].filter((r) => !r.id.startsWith('import-')).sort((a, b) => b.end.localeCompare(a.end))[0];
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
  // Sheet-import runs span the whole imported history; they never block a real pay period.
  if (runs.some((r) => !r.id.startsWith('import-') && r.start <= p.end && r.end >= p.start)) throw new HttpError(400, `A run already covers ${label(p.start, p.end)}`);
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

/** Approved too soon? Back to draft. Statements already emailed stay sent; the audit trail shows both moves. */
export async function reopenRun(repo: Repo, id: string, actorRepId: string): Promise<PayrollRun> {
  const run = (await repo.listRuns()).find((r) => r.id === id);
  if (!run) throw new HttpError(404, `Run ${id} not found`);
  if (run.status !== 'approved') throw new HttpError(400, run.status === 'paid' ? `${run.label} is paid and locked` : `${run.label} is already a draft`);
  await repo.updateRun(id, { status: 'draft', approvedAt: null });
  await repo.writeAudit({ actorRepId, action: 'payroll.run.reopen', targetRepId: null, path: `/api/admin/payroll/runs/${id}/reopen`, detail: { label: run.label } });
  return { ...run, status: 'draft' };
}

/** Close out a run that was opened by mistake. Only a draft with nothing paid in it can go; paid history is never deleted. */
export async function deleteRun(repo: Repo, id: string, actorRepId: string): Promise<{ deleted: string }> {
  const run = (await repo.listRuns()).find((r) => r.id === id);
  if (!run) throw new HttpError(404, `Run ${id} not found`);
  if (run.status !== 'draft') throw new HttpError(400, `${run.label} is ${run.status} — only draft runs can be removed`);
  const ctx = await repo.loadContext();
  if (ctx.lines.some((l) => l.runId === id)) throw new HttpError(400, `${run.label} has payouts recorded in it — void them first or mark the run paid`);
  await repo.deleteRun(id);
  await repo.writeAudit({ actorRepId, action: 'payroll.run.delete', targetRepId: null, path: `/api/admin/payroll/runs/${id}`, detail: { label: run.label } });
  return { deleted: id };
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

export interface VoidRequestInput {
  runId: string;
  repId: string;
  /** Exact ledger row keys; omit to void everything paid to the rep in the run. */
  keys?: string[];
}

/**
 * Reverse a payout. Nothing is deleted: Void rows are appended, the lines
 * become payable again, any clawback recovery withheld goes back on the
 * clawback, and "paid in full" stamps that no longer hold are cleared.
 */
export async function voidPayout(repo: Repo, req: VoidRequestInput, actorRepId: string): Promise<VoidPlan> {
  const runs = await repo.listRuns();
  const run = runs.find((r) => r.id === req.runId);
  if (!run) throw new HttpError(404, `Run ${req.runId} not found`);
  const ctx = await repo.loadContext();
  let plan: VoidPlan;
  try {
    plan = planVoid(ctx, { repId: req.repId, runId: run.id, keys: req.keys, paidAt: today() });
  } catch (e) {
    if (e instanceof VoidError) throw new HttpError(400, e.message);
    throw e;
  }
  applyVoid(ctx, plan);
  await repo.commitPayout({ lines: plan.lines, clawbackUpdates: plan.clawbackUpdates, dealsFullyPaid: [], dealsUnstamped: plan.dealsUnstamped, paidAt: today() });
  await repo.writeAudit({ actorRepId, action: 'payroll.void', targetRepId: req.repId, path: `/api/admin/payroll/runs/${run.id}/void`, detail: { rows: plan.lines.length, reversed: plan.reversed, recoveriesReturned: plan.recoveriesReturned, keys: plan.lines.map((l) => l.voids) } });
  return plan;
}
