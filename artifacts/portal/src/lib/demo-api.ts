/**
 * In-browser stand-in for the API, used by the demo build (VITE_DEMO=1).
 * It runs the SAME services and projections the Express server runs, over an
 * in-memory repo holding the deterministic demo board — no network, no
 * database. Rep scoping and View-as authorization are mirrored exactly, and
 * writes (new deals, draws, collection, splits) mutate the in-memory board.
 */
import { repDeals, repLedger, repOptions, type Rep, type Team } from '@greystone/commission';
import { buildDemo, type DemoData } from '@greystone/db/seed/demo';
import { LENDERS, LISTS, PARTNERS, PRODUCTS, THRESHOLDS } from '@greystone/db/seed';
import { adminDealDetail, adminDealRow, adminRenewals } from '../../../api-server/src/admin-views';
import { memoryRepo } from '../../../api-server/src/repo.memory';
import { leaderboard, repClawbackViews, repDashboard, repDealView, repMonthly, repPayHistory, repRenewals, repStatements, repWallet } from '../../../api-server/src/scope';
import { addDraw, createDeal, setCollection, setCrmId, setDealStatus, updateSplits } from '../../../api-server/src/services/deals';
import { advanceRun, createRun, paySelected } from '../../../api-server/src/services/payroll';
import { payrollRepDetail, payrollReps, preview, runSummary } from '../../../api-server/src/payroll-views';
import { ApiError, type SessionUser } from './api';

let repo: ReturnType<typeof memoryRepo> | null = null;
let demo: DemoData | null = null;
function board() {
  if (!demo) {
    demo = buildDemo(new Date().toISOString().slice(0, 10));
    repo = memoryRepo({ reps: demo.reps, teams: demo.teams, runs: demo.runs, deals: demo.deals, lines: demo.lines, clawbacks: demo.clawbacks, settings: { lenders: [...LENDERS], partners: [...PARTNERS], products: [...PRODUCTS], thresholds: THRESHOLDS, lists: LISTS, crm: { urlTemplate: '' }, payroll: { cycle: 'Twice monthly' } } });
  }
  return { d: demo!, repo: repo! };
}

const KEY = 'gs-demo-user';
const OUT = 'gs-demo-signed-out';
let memoryUser: SessionUser | null | undefined;
const store = {
  get(k: string) {
    try { return sessionStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string | null) {
    try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* storage blocked — memory only */ }
  },
};
function user(): SessionUser | null {
  if (memoryUser !== undefined) return memoryUser;
  try {
    const stored = JSON.parse(store.get(KEY) ?? 'null') as SessionUser | null;
    if (stored) return (memoryUser = stored);
  } catch { /* ignore */ }
  if (store.get(OUT) === '1') return (memoryUser = null);
  // First visit: open straight into a rep's portal so the preview shows something at rest.
  const rep = board().d.reps.find((r) => r.name === 'Julian Ribak')!;
  memoryUser = { repId: rep.id, email: rep.email, name: rep.name, role: rep.role };
  store.set(KEY, JSON.stringify(memoryUser));
  return memoryUser;
}
function setUser(u: SessionUser | null) {
  memoryUser = u;
  store.set(KEY, u ? JSON.stringify(u) : null);
  store.set(OUT, u ? null : '1');
}

function canViewAs(reps: Rep[], _teams: Team[], actor: SessionUser, targetId: string): { ok: true; target: Rep } | { ok: false; reason: string } {
  const target = reps.find((r) => r.id === targetId);
  if (!target) return { ok: false, reason: `Unknown rep ${targetId}` };
  if (target.id === actor.repId || actor.role === 'admin') return { ok: true, target };
  if (actor.role === 'manager') {
    const me = reps.find((r) => r.id === actor.repId);
    if (me?.teamId && target.teamId === me.teamId) return { ok: true, target };
    return { ok: false, reason: `${target.name} is not on your team` };
  }
  return { ok: false, reason: 'Reps can only view their own portal' };
}

/** Errors thrown by the shared services are HttpError-shaped ({status, message}). */
function rethrow(e: unknown): never {
  if (e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number') throw new ApiError((e as { status: number }).status, String((e as { message?: unknown }).message ?? 'Request failed'));
  throw e;
}

export async function demoFetch<T>(path: string, init: RequestInit, viewAs: string | null): Promise<T> {
  const url = new URL(path, 'http://demo');
  const p = url.pathname;
  const q = url.searchParams;
  const method = (init.method ?? 'GET').toUpperCase();
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  const { d, repo } = board();
  const ctx = await repo.loadContext();
  const u = user();
  const json = (v: unknown) => v as T;
  const today = d.today;
  const settings = await repo.getSettings();

  if (p === '/auth/methods') return json({ oidc: false, devAuth: true });
  if (p === '/auth/me') {
    if (!u) throw new ApiError(401, 'Sign in required');
    return json({ user: u, canViewAs: u.role !== 'rep', oidc: false, devAuth: true });
  }
  if (p === '/auth/dev-login') {
    const email = (q.get('email') ?? '').trim().toLowerCase();
    const rep = d.reps.find((r) => r.email.toLowerCase() === email);
    if (!rep) throw new ApiError(403, `${email} is not provisioned in the commission portal`);
    if (!rep.active) throw new ApiError(403, `${rep.name} is inactive — ask an admin to reactivate the account`);
    const su: SessionUser = { repId: rep.id, email: rep.email, name: rep.name, role: rep.role };
    setUser(su);
    return json({ ok: true, user: su });
  }
  if (p === '/auth/logout' && method === 'POST') {
    setUser(null);
    return json({ ok: true, redirect: null });
  }
  if (!u) throw new ApiError(401, 'Sign in required');
  const me = u;

  let effective = me.repId;
  let viewing = false;
  if (viewAs && viewAs !== me.repId) {
    const check = canViewAs(d.reps, d.teams, me, viewAs);
    if (!check.ok) throw new ApiError(403, check.reason);
    effective = check.target.id;
    viewing = true;
    await repo.writeAudit({ actorRepId: me.repId, action: 'view-as', targetRepId: effective, path: p });
  }

  if (p === '/api/me') {
    const rep = d.reps.find((r) => r.id === effective)!;
    return json({ rep: { id: rep.id, name: rep.name, email: rep.email, role: rep.role, active: rep.active }, viewAs: viewing, actor: viewing ? { id: me.repId, name: me.name, role: me.role } : null });
  }
  if (p === '/api/me/dashboard') {
    const to = q.get('to') ?? today;
    const from = q.get('from') ?? `${to.slice(0, 4)}-01-01`;
    if (from > to) throw new ApiError(400, 'from must not be after to');
    return json(repDashboard(ctx, d.reps, d.runs, effective, from, to, 'Twice monthly'));
  }
  if (p === '/api/me/wallet') return json(repWallet(ctx, effective));
  if (p === '/api/me/deals') {
    const rows = repDeals(ctx.deals, effective).map((x) => repDealView(x, effective, ctx.lines, ctx.clawbacks));
    return json({ count: rows.length, deals: rows });
  }
  const dealMatch = p.match(/^\/api\/me\/deals\/([^/]+)$/);
  if (dealMatch) {
    const id = decodeURIComponent(dealMatch[1]!);
    const deal = ctx.deals.find((x) => x.id === id);
    if (!deal || !repDeals([deal], effective).length) throw new ApiError(404, 'Deal not found');
    const view = repDealView(deal, effective, ctx.lines, ctx.clawbacks);
    const payments = ctx.lines.filter((l) => l.repId === effective && l.dealId === deal.id).map((l) => ({ role: l.role, segmentKey: l.segmentKey, amount: l.amount, paidAt: l.paidAt, runId: l.runId })).sort((a, b) => a.paidAt.localeCompare(b.paidAt));
    return json({ ...view, payments });
  }
  if (p === '/api/me/clawbacks') return json({ clawbacks: repClawbackViews(ctx, effective) });
  if (p === '/api/me/statements') return json({ statements: repStatements(ctx, d.runs, effective) });
  if (p === '/api/me/payments') return json(repPayHistory(ctx, d.runs, effective));
  if (p === '/api/me/renewals') return json({ renewals: repRenewals(ctx, effective, { renewalMark: settings.thresholds.renewalMark }, today) });
  if (p === '/api/me/leaderboard') return json({ rows: leaderboard(ctx, d.reps, effective) });
  if (p === '/api/me/monthly') return json({ series: repMonthly(ctx, effective, (q.get('months') ?? '').split(',').filter(Boolean)) });

  /* ---- admin / manager ---- */
  const requireRole = (...roles: string[]) => {
    if (!roles.includes(me.role)) throw new ApiError(403, `This requires one of: ${roles.join(', ')}`);
  };
  if (p === '/api/admin/teams') {
    requireRole('admin', 'manager');
    return json({ teams: d.teams });
  }
  if (p === '/api/admin/reps/options') {
    requireRole('admin', 'manager');
    const purpose = q.get('purpose');
    if (purpose !== 'assign' && purpose !== 'edit' && purpose !== 'view-as') throw new ApiError(400, 'purpose must be assign, edit or view-as');
    let reps = d.reps;
    if (purpose === 'view-as' && me.role === 'manager') {
      const mine = reps.find((x) => x.id === me.repId);
      reps = reps.filter((x) => x.id === me.repId || (mine?.teamId && x.teamId === mine.teamId));
    }
    return json({ options: repOptions(reps, purpose) });
  }
  requireRole('admin');
  if (p === '/api/admin/reps') {
    const teamName = new Map(d.teams.map((t) => [t.id, t.name]));
    return json({
      reps: d.reps.map((rep) => {
        const l = repLedger(ctx, rep.id);
        return { id: rep.id, name: rep.name, email: rep.email, role: rep.role, teamId: rep.teamId, team: rep.teamId ? teamName.get(rep.teamId) ?? null : null, openerRate: rep.openerRate, closerRate: rep.closerRate, overrideRate: rep.overrideRate, active: rep.active, earned: l.earned, paid: l.paid, held: l.held, owed: l.owed, dealCount: l.deals.length };
      }),
    });
  }
  if (p === '/api/admin/audit') return json({ entries: await repo.listAudit(100) });
  if (p === '/api/admin/settings') return json(settings);
  if (p === '/api/admin/renewals') return json({ renewals: adminRenewals(ctx, d.reps, settings, today) });

  const detail = async (id: string) => {
    const c = await repo.loadContext();
    const deal = c.deals.find((x) => x.id === id);
    if (!deal) throw new ApiError(404, 'Deal not found');
    return adminDealDetail(deal, c, d.reps, settings, today);
  };
  try {
    if (p === '/api/admin/payroll') {
      const rows = payrollReps(ctx, d.reps);
      return json({ runs: [...d.runs].sort((a, b) => b.start.localeCompare(a.start)).map((run) => runSummary(run, ctx)), reps: rows, outstanding: rows.reduce((s2, x) => s2 + x.owed, 0) });
    }
    if (p === '/api/admin/payroll/runs' && method === 'POST') return json(await createRun(repo, me.repId, body.start && body.end ? { start: String(body.start), end: String(body.end) } : undefined));
    if (p === '/api/admin/payroll/preview' && method === 'POST') return json(preview(ctx, String(body.repId ?? ''), Array.isArray(body.selectedKeys) ? (body.selectedKeys as string[]) : []));
    const pr = p.match(/^\/api\/admin\/payroll\/runs\/([^/]+)\/(advance|pay|reps\/([^/]+))$/);
    if (pr) {
      const runId = decodeURIComponent(pr[1]!);
      if (pr[2] === 'advance') return json(await advanceRun(repo, runId, me.repId));
      if (pr[2] === 'pay') {
        const plan = await paySelected(repo, { runId, repId: String(body.repId ?? ''), selectedKeys: Array.isArray(body.selectedKeys) ? (body.selectedKeys as string[]) : [] }, me.repId);
        return json({ repId: plan.repId, runId: plan.runId, gross: plan.gross, withheld: plan.withheld, net: plan.net, lines: plan.lines.length, recoveries: plan.recoveries.length, dealsFullyPaid: plan.dealsFullyPaid, uncollectedDealIds: plan.uncollectedDealIds });
      }
      const rep = d.reps.find((r) => r.id === decodeURIComponent(pr[3]!));
      if (!rep) throw new ApiError(404, 'Rep not found');
      return json(payrollRepDetail(await repo.loadContext(), rep, runId));
    }
    if (p === '/api/admin/deals' && method === 'GET') {
      const s = (q.get('search') ?? '').trim().toLowerCase();
      const rep = q.get('rep') ?? '';
      const status = q.get('status') ?? '';
      let deals = ctx.deals;
      if (rep) deals = deals.filter((x) => x.openerId === rep || x.closerId === rep || x.overrideId === rep);
      let rows = deals.map((x) => adminDealRow(x, ctx, d.reps, settings, today));
      if (s) rows = rows.filter((x) => `${x.id} ${x.business} ${x.merchantContact} ${x.merchantEmail} ${x.merchantPhone} ${x.lender} ${x.product}`.toLowerCase().includes(s));
      if (status) rows = rows.filter((x) => x.commissionStatus === status || x.dealStatus === status);
      return json({ count: rows.length, deals: rows, repOptions: { assign: repOptions(d.reps, 'assign'), edit: repOptions(d.reps, 'edit') } });
    }
    if (p === '/api/admin/deals' && method === 'POST') {
      const deal = await createDeal(repo, body as never, me.repId);
      return json(await detail(deal.id));
    }
    const m = p.match(/^\/api\/admin\/deals\/([^/]+)(?:\/(splits|status|draws|collection|crm))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const sub = m[2];
      if (!sub) return json(await detail(id));
      if (sub === 'splits') await updateSplits(repo, id, body as never, me.repId);
      if (sub === 'status') await setDealStatus(repo, id, String(body.dealStatus ?? ''), me.repId);
      if (sub === 'crm') await setCrmId(repo, id, body.crmId === null ? null : String(body.crmId ?? ''), me.repId);
      if (sub === 'draws') await addDraw(repo, id, body as never, me.repId);
      if (sub === 'collection') await setCollection(repo, id, body as never, me.repId);
      return json(await detail(id));
    }
  } catch (e) {
    rethrow(e);
  }
  throw new ApiError(404, 'Not found');
}
