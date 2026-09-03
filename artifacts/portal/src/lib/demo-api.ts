/**
 * In-browser stand-in for the API, used by the demo build (VITE_DEMO=1).
 * It runs the same domain layer and rep projections the server runs, over
 * the deterministic demo board — no network, no database. Every rule the
 * server enforces (rep scoping, View-as authorization) is mirrored here so
 * the preview behaves like the real thing.
 */
import { repDeals, repLedger, repOptions, type LedgerContext, type Rep, type Team } from '@greystone/commission';
import { buildDemo, type DemoData } from '@greystone/db/seed/demo';
import { leaderboard, repClawbackViews, repDashboard, repDealView, repMonthly, repStatements, repWallet } from '../../../api-server/src/scope';
import { ApiError, type SessionUser } from './api';

let demo: DemoData | null = null;
const board = () => (demo ??= buildDemo(new Date().toISOString().slice(0, 10)));
const ctxOf = (d: DemoData): LedgerContext => ({ deals: d.deals, lines: d.lines, clawbacks: d.clawbacks });

const KEY = 'gs-demo-user';
const OUT = 'gs-demo-signed-out';
let memoryUser: SessionUser | null | undefined;
const store = {
  get(k: string) {
    try { return sessionStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string | null) {
    try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* storage blocked — fall back to memory */ }
  },
};
function user(): SessionUser | null {
  if (memoryUser !== undefined) return memoryUser;
  try {
    const stored = JSON.parse(store.get(KEY) ?? 'null') as SessionUser | null;
    if (stored) return (memoryUser = stored);
  } catch { /* ignore */ }
  // First visit: open straight into a rep's portal so the preview shows something at rest.
  if (store.get(OUT) === '1') return (memoryUser = null);
  const rep = board().reps.find((r) => r.name === 'Julian Ribak')!;
  memoryUser = { repId: rep.id, email: rep.email, name: rep.name, role: rep.role };
  store.set(KEY, JSON.stringify(memoryUser));
  return memoryUser;
}
function setUser(u: SessionUser | null) {
  memoryUser = u;
  store.set(KEY, u ? JSON.stringify(u) : null);
  store.set(OUT, u ? null : '1');
}
const audit: Array<{ actorRepId: string; action: string; targetRepId: string | null; path: string | null; at: string }> = [];

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

export async function demoFetch<T>(path: string, init: RequestInit, viewAs: string | null): Promise<T> {
  const url = new URL(path, 'http://demo');
  const p = url.pathname;
  const q = url.searchParams;
  const d = board();
  const ctx = ctxOf(d);
  const u = user();
  const json = (v: unknown) => v as T;
  const requireUser = () => {
    if (!u) throw new ApiError(401, 'Sign in required');
    return u;
  };

  if (p === '/auth/methods') return json({ oidc: false, devAuth: true });
  if (p === '/auth/me') {
    const me = requireUser();
    return json({ user: me, canViewAs: me.role !== 'rep', oidc: false, devAuth: true });
  }
  if (p === '/auth/dev-login') {
    const email = (q.get('email') ?? '').trim().toLowerCase();
    const rep = d.reps.find((r) => r.email.toLowerCase() === email);
    if (!rep) throw new ApiError(403, `${email} is not provisioned in the commission portal`);
    if (!rep.active) throw new ApiError(403, `${rep.name} is inactive — ask an admin to reactivate the account`);
    const su: SessionUser = { repId: rep.id, email: rep.email, name: rep.name, role: rep.role };
    setUser(su);
    audit.push({ actorRepId: rep.id, action: 'login', targetRepId: null, path: '/auth/dev-login', at: new Date().toISOString() });
    return json({ ok: true, user: su });
  }
  if (p === '/auth/logout' && init.method === 'POST') {
    if (u) audit.push({ actorRepId: u.repId, action: 'logout', targetRepId: null, path: '/auth/logout', at: new Date().toISOString() });
    setUser(null);
    return json({ ok: true, redirect: null });
  }

  const me = requireUser();

  // Server-side scope: resolve the effective rep, refuse unauthorized View-as, audit it.
  let effective = me.repId;
  let viewing = false;
  if (viewAs && viewAs !== me.repId) {
    const check = canViewAs(d.reps, d.teams, me, viewAs);
    if (!check.ok) throw new ApiError(403, check.reason);
    effective = check.target.id;
    viewing = true;
    audit.push({ actorRepId: me.repId, action: 'view-as', targetRepId: effective, path: p, at: new Date().toISOString() });
  }

  if (p === '/api/me') {
    const rep = d.reps.find((r) => r.id === effective)!;
    return json({ rep: { id: rep.id, name: rep.name, email: rep.email, role: rep.role, active: rep.active }, viewAs: viewing, actor: viewing ? { id: me.repId, name: me.name, role: me.role } : null });
  }
  if (p === '/api/me/dashboard') {
    const to = q.get('to') ?? d.today;
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
    const payments = ctx.lines
      .filter((l) => l.repId === effective && l.dealId === deal.id)
      .map((l) => ({ role: l.role, segmentKey: l.segmentKey, amount: l.amount, paidAt: l.paidAt, runId: l.runId }))
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt));
    return json({ ...view, payments });
  }
  if (p === '/api/me/clawbacks') return json({ clawbacks: repClawbackViews(ctx, effective) });
  if (p === '/api/me/statements') return json({ statements: repStatements(ctx, d.runs, effective) });
  if (p === '/api/me/leaderboard') return json({ rows: leaderboard(ctx, d.reps, effective) });
  if (p === '/api/me/monthly') return json({ series: repMonthly(ctx, effective, (q.get('months') ?? '').split(',').filter(Boolean)) });

  if (p === '/api/admin/reps') {
    if (me.role !== 'admin') throw new ApiError(403, 'This requires one of: admin');
    const teamName = new Map(d.teams.map((t) => [t.id, t.name]));
    return json({
      reps: d.reps.map((rep) => {
        const l = repLedger(ctx, rep.id);
        return { id: rep.id, name: rep.name, email: rep.email, role: rep.role, teamId: rep.teamId, team: rep.teamId ? teamName.get(rep.teamId) ?? null : null, openerRate: rep.openerRate, closerRate: rep.closerRate, overrideRate: rep.overrideRate, active: rep.active, earned: l.earned, paid: l.paid, held: l.held, owed: l.owed, dealCount: l.deals.length };
      }),
    });
  }
  if (p === '/api/admin/reps/options') {
    if (me.role === 'rep') throw new ApiError(403, 'This requires one of: admin, manager');
    const purpose = q.get('purpose');
    if (purpose !== 'assign' && purpose !== 'edit' && purpose !== 'view-as') throw new ApiError(400, 'purpose must be assign, edit or view-as');
    let reps = d.reps;
    if (purpose === 'view-as' && me.role === 'manager') {
      const mine = reps.find((x) => x.id === me.repId);
      reps = reps.filter((x) => x.id === me.repId || (mine?.teamId && x.teamId === mine.teamId));
    }
    return json({ options: repOptions(reps, purpose) });
  }
  if (p === '/api/admin/audit') {
    if (me.role !== 'admin') throw new ApiError(403, 'This requires one of: admin');
    return json({ entries: [...audit].reverse().slice(0, 100) });
  }
  throw new ApiError(404, 'Not found');
}
