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
import { adminMerchants, adminOverview } from '../../../api-server/src/analytics-views';
import { memoryRepo } from '../../../api-server/src/repo.memory';
import { leaderboard, repClawbackViews, repDashboard, repDealView, repMonthly, repPayHistory, repRenewals, repStatements, repWallet } from '../../../api-server/src/scope';
import { addDraw, createDeal, deleteClawback, deleteDeal, deleteDraw, recordClawback, setCollection, setCrmId, setDealStatus, updateClawback, updateContact, updateDrawTerms, updateSplits, updateTerms } from '../../../api-server/src/services/deals';
import { addFile, addNote, removeFile, removeNote } from '../../../api-server/src/services/notes';
import { advanceRun, createRun, deleteRun, paySelected, reopenRun, voidPayout } from '../../../api-server/src/services/payroll';
import { commitImport, previewImport } from '../../../api-server/src/services/import';
import { commitRemittance, previewRemittance } from '../../../api-server/src/services/remittance';
import { base64ToBytes, readXlsx } from '@greystone/db/seed/xlsx';

/** Browser-side .xlsx decoding for the demo: DecompressionStream stands in for node:zlib. */
async function demoSheetGrid(body: Record<string, unknown>): Promise<string[][] | undefined> {
  if (typeof body.xlsx !== 'string' || !body.xlsx) return undefined;
  const inflate = async (b: Uint8Array) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  const wb = await readXlsx(base64ToBytes(body.xlsx), inflate);
  const ok = (g: string[][]) => g.some((r) => r.some((c) => c.trim().toLowerCase() === 'business name') && r.some((c) => c.trim().toLowerCase() === 'lender'));
  const sheet = wb.sheets.find((s) => s.name.toLowerCase() === 'funded deals' && ok(s.grid)) ?? wb.sheets.find((s) => /funded/i.test(s.name) && ok(s.grid)) ?? wb.sheets.find((s) => ok(s.grid));
  if (!sheet) throw new ApiError(400, `No FUNDED DEALS tab found (sheets: ${wb.sheets.map((s) => s.name).join(', ')})`);
  return sheet.grid;
}
import { createRep, createTeam, deleteTeam, saveCrm, saveLenders, savePartners, savePayroll, saveProducts, saveThresholds, updateRep, updateTeam, usage } from '../../../api-server/src/services/settings';
import { annualReport, payrollRepDetail, payrollReps, preview, runSummary } from '../../../api-server/src/payroll-views';
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
  const rep = board().d.reps.find((r) => r.name === 'Noah Levine')!;
  memoryUser = { repId: rep.id, email: rep.email, name: rep.name, role: rep.role };
  store.set(KEY, JSON.stringify(memoryUser));
  return memoryUser;
}
/** Demo only: passwords set in Settings live in memory for this tab. */
const demoPasswords = new Map<string, string>();
/** Demo only: two-factor is a flag — any 6 digits enrol, and sign-in skips the code step. */
const demoTotp = new Set<string>();
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

  if (p === '/auth/methods') return json({ oidc: false, devAuth: true, password: true });
  if (p === '/auth/me') {
    if (!u) throw new ApiError(401, 'Sign in required');
    return json({ user: u, canViewAs: u.role !== 'rep', oidc: false, devAuth: true, password: true });
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
  if (p === '/auth/password-login' && method === 'POST') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const rep = d.reps.find((r) => r.email.toLowerCase() === email);
    const want = rep ? demoPasswords.get(rep.id) : undefined;
    // Demo: a rep with no password set accepts any password; one with a password must match it.
    if (!rep || (want !== undefined && want !== String(body.password ?? ''))) throw new ApiError(401, 'That email and password do not match');
    if (!rep.active) throw new ApiError(403, `${rep.name} is inactive — ask an admin to reactivate the account`);
    const su: SessionUser = { repId: rep.id, email: rep.email, name: rep.name, role: rep.role };
    setUser(su);
    return json({ ok: true, user: su });
  }
  if (p === '/auth/forgot' && method === 'POST') return json({ ok: true, message: 'Demo: no email goes out here. On a real portal a one-hour reset link lands in that inbox.' });
  if (p === '/auth/reset' && method === 'POST') throw new ApiError(400, 'Demo: reset links only work on a real portal with email configured');
  if (p === '/auth/totp' && method === 'POST') throw new ApiError(400, 'Start again with your email and password');
  if (p === '/auth/logout' && method === 'POST') {
    setUser(null);
    return json({ ok: true, redirect: null });
  }
  if (!u) throw new ApiError(401, 'Sign in required');
  if (p === '/api/me/password' && method === 'POST') {
    const have = demoPasswords.get(u.repId);
    if (have !== undefined && have !== String(body.current ?? '')) throw new ApiError(400, 'Your current password is not right');
    const nx = String(body.next ?? '');
    if (nx.length < 10 || !/[a-zA-Z]/.test(nx) || !/[0-9]/.test(nx)) throw new ApiError(400, 'Passwords need at least 10 characters with a letter and a number');
    demoPasswords.set(u.repId, nx);
    return json({ ok: true });
  }
  if (p === '/api/me/totp') return json({ enabled: demoTotp.has(u.repId), pending: false });
  if (p === '/api/me/totp/setup' && method === 'POST') return json({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauth: `otpauth://totp/Greystone%20(demo):${encodeURIComponent(u.email)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Greystone%20(demo)` });
  if (p === '/api/me/totp/enable' && method === 'POST') {
    if (!/^\d{6}$/.test(String(body.code ?? '').replace(/\s/g, ''))) throw new ApiError(400, 'Enter the 6-digit code');
    demoTotp.add(u.repId);
    return json({ ok: true, enabled: true });
  }
  if (p === '/api/me/totp/disable' && method === 'POST') { demoTotp.delete(u.repId); return json({ ok: true, enabled: false }); }
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
  const qm = p.match(/^\/api\/me\/deals\/([^/]+)\/question$/);
  if (qm && method === 'POST') {
    const text = String(body.text ?? '').trim();
    if (!text) throw new ApiError(400, 'Write your question first');
    await repo.insertNote({ id: `note-${Date.now().toString(36)}`, dealId: decodeURIComponent(qm[1]!), authorRepId: me.repId, body: `[Question from ${me.name}] ${text}`, createdAt: new Date().toISOString() });
    return json({ ok: true, emailed: 0 });
  }
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
  if (p === '/api/me/renewals') return json({ renewals: repRenewals(ctx, effective, { renewalMark: settings.thresholds.renewalMark, additionalCapitalAfterDays: settings.thresholds.additionalCapitalAfterDays }, today), thresholds: { renewalMark: settings.thresholds.renewalMark, additionalCapitalAfterDays: settings.thresholds.additionalCapitalAfterDays } });
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
        return { id: rep.id, name: rep.name, email: rep.email, role: rep.role, teamId: rep.teamId, team: rep.teamId ? teamName.get(rep.teamId) ?? null : null, openerRate: rep.openerRate, closerRate: rep.closerRate, overrideRate: rep.overrideRate, active: rep.active, hasPassword: demoPasswords.has(rep.id), hasTotp: demoTotp.has(rep.id), earned: l.earned, paid: l.paid, held: l.held, owed: l.owed, dealCount: l.deals.length };
      }),
    });
  }
  if (p === '/api/admin/audit') { const lim = Number(q.get('limit') ?? 100); const entries = await repo.listAudit(lim); return json({ entries, limit: lim, offset: 0, hasMore: entries.length === lim }); }
  if (p === '/api/admin/settings') return json(settings);
  if (p === '/api/admin/settings/usage') return json(await usage(repo));
  try {
    const sm = p.match(/^\/api\/admin\/settings\/(lenders|partners|products|thresholds|crm|payroll)$/);
    if (sm && method === 'PUT') {
      const k = sm[1]!;
      if (k === 'lenders') return json({ lenders: await saveLenders(repo, body.lenders, me.repId) });
      if (k === 'partners') return json({ partners: await savePartners(repo, body.partners, me.repId) });
      if (k === 'products') return json({ products: await saveProducts(repo, body.products, me.repId) });
      if (k === 'thresholds') return json({ thresholds: await saveThresholds(repo, body, me.repId) });
      if (k === 'crm') return json({ crm: await saveCrm(repo, body, me.repId) });
      return json({ payroll: await savePayroll(repo, body, me.repId) });
    }
    if (p === '/api/admin/teams' && method === 'POST') return json(await createTeam(repo, body as never, me.repId));
    const tm = p.match(/^\/api\/admin\/teams\/([^/]+)$/);
    if (tm && method === 'PATCH') return json(await updateTeam(repo, decodeURIComponent(tm[1]!), body as never, me.repId));
    if (tm && method === 'DELETE') { await deleteTeam(repo, decodeURIComponent(tm[1]!), me.repId); return json(null); }
    if (p === '/api/admin/import/preview' && method === 'POST') return json(await previewImport(repo, String(body.csv ?? ''), { skipExisting: !!body.skipExisting, grid: await demoSheetGrid(body) }));
    if (p === '/api/admin/import' && method === 'POST') return json(await commitImport(repo, String(body.csv ?? ''), me.repId, { skipExisting: !!body.skipExisting, grid: await demoSheetGrid(body) }));
    if (p === '/api/admin/remittance/preview' && method === 'POST') return json(await previewRemittance(repo, String(body.csv ?? '')));
    if (p === '/api/admin/remittance' && method === 'POST') return json(await commitRemittance(repo, String(body.csv ?? ''), me.repId));
    if (p === '/api/admin/reports/annual') return json(annualReport(ctx, d.reps, Number(q.get('year') ?? today.slice(0, 4))));
    if (p === '/api/admin/reps' && method === 'POST') return json(await createRep(repo, body as never, me.repId));
    const rm = p.match(/^\/api\/admin\/reps\/([^/]+)$/);
    if (rm && method === 'PATCH') return json(await updateRep(repo, decodeURIComponent(rm[1]!), body as never, me.repId));
    const tm2 = p.match(/^\/api\/admin\/reps\/([^/]+)\/totp$/);
    if (tm2 && method === 'DELETE') { demoTotp.delete(decodeURIComponent(tm2[1]!)); return json({ ok: true, hasTotp: false }); }
    const pm = p.match(/^\/api\/admin\/reps\/([^/]+)\/password$/);
    if (pm && method === 'POST') {
      const id = decodeURIComponent(pm[1]!);
      if (body.password === null) { demoPasswords.delete(id); return json({ hasPassword: false }); }
      const pw = String(body.password ?? '');
      if (pw.length < 10 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) throw new ApiError(400, 'Passwords need at least 10 characters with a letter and a number');
      demoPasswords.set(id, pw);
      return json({ hasPassword: true });
    }
  } catch (e) {
    rethrow(e);
  }
  if (p === '/api/admin/renewals') return json({ renewals: adminRenewals(ctx, d.reps, settings, today) });
  if (p === '/api/admin/merchants') return json({ merchants: adminMerchants(ctx, settings, today) });
  if (p === '/api/admin/overview') {
    const to = q.get('to') ?? today;
    const from = q.get('from') ?? `${to.slice(0, 4)}-01-01`;
    if (from > to) throw new ApiError(400, 'from must not be after to');
    return json(adminOverview(ctx, d.reps, settings, from, to, today));
  }

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
    const vm = p.match(/^\/api\/admin\/payroll\/runs\/([^/]+)\/void$/);
    if (vm && method === 'POST') {
      const plan = await voidPayout(repo, { runId: decodeURIComponent(vm[1]!), repId: String(body.repId ?? ''), keys: Array.isArray(body.keys) ? (body.keys as unknown[]).map(String) : undefined }, me.repId);
      return json({ rows: plan.lines.length, reversed: plan.reversed, recoveriesReturned: plan.recoveriesReturned, dealsUnstamped: plan.dealsUnstamped });
    }
    if (p === '/api/admin/payroll/preview' && method === 'POST') return json(preview(ctx, String(body.repId ?? ''), Array.isArray(body.selectedKeys) ? (body.selectedKeys as string[]) : []));
    const rd = p.match(/^\/api\/admin\/payroll\/runs\/([^/]+)$/);
    if (rd && method === 'DELETE') return json(await deleteRun(repo, decodeURIComponent(rd[1]!), me.repId));
    const pr = p.match(/^\/api\/admin\/payroll\/runs\/([^/]+)\/(advance|reopen|pay|reps\/([^/]+))$/);
    if (pr) {
      const runId = decodeURIComponent(pr[1]!);
      if (pr[2] === 'advance') return json({ ...(await advanceRun(repo, runId, me.repId)), notified: 0 });
      if (pr[2] === 'reopen') return json(await reopenRun(repo, runId, me.repId));
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
    const xm = p.match(/^\/api\/admin\/deals\/([^/]+)\/(clawbacks|notes|files)(?:\/([^/]+))?$/);
    if (xm) {
      const id = decodeURIComponent(xm[1]!);
      const kind = xm[2]!;
      const sub = xm[3];
      const names = new Map(d.reps.map((r) => [r.id, r.name]));
      if (kind === 'clawbacks' && method === 'POST') {
        await recordClawback(repo, id, body as never, me.repId);
        return json({ ...(await detail(id)), notified: 0 });
      }
      if (kind === 'clawbacks' && sub && method === 'PATCH') { await updateClawback(repo, id, sub, body as never, me.repId); return json(await detail(id)); }
      if (kind === 'clawbacks' && sub && method === 'DELETE') { await deleteClawback(repo, id, sub, me.repId); return json(await detail(id)); }
      if (kind === 'notes') {
        if (method === 'POST') await addNote(repo, id, body.body, me.repId);
        if (method === 'DELETE' && sub) await removeNote(repo, id, sub, me.repId);
        return json({ notes: (await repo.listNotes(id)).map((n) => ({ ...n, author: names.get(n.authorRepId) ?? n.authorRepId })) });
      }
      if (kind === 'files') {
        if (method === 'POST') await addFile(repo, id, body as never, me.repId);
        if (method === 'DELETE' && sub) await removeFile(repo, id, sub, me.repId);
        if (method === 'GET' && sub) throw new ApiError(400, 'Demo: downloads work on a real portal');
        return json({ files: (await repo.listFiles(id)).map((f) => ({ ...f, uploadedByName: names.get(f.uploadedBy) ?? f.uploadedBy })) });
      }
    }
    const dm2 = p.match(/^\/api\/admin\/deals\/([^/]+)\/draws\/([^/]+)$/);
    if (dm2 && method === 'PATCH') { await updateDrawTerms(repo, decodeURIComponent(dm2[1]!), dm2[2]!, body as never, me.repId); return json(await detail(decodeURIComponent(dm2[1]!))); }
    if (dm2 && method === 'DELETE') { await deleteDraw(repo, decodeURIComponent(dm2[1]!), dm2[2]!, me.repId); return json(await detail(decodeURIComponent(dm2[1]!))); }
    const cm = p.match(/^\/api\/admin\/deals\/([^/]+)\/contact$/);
    if (cm && method === 'PATCH') { const r2 = await updateContact(repo, decodeURIComponent(cm[1]!), body as never, me.repId); return json({ ...(await detail(decodeURIComponent(cm[1]!))), updatedDeals: r2.updated }); }
    const m = p.match(/^\/api\/admin\/deals\/([^/]+)(?:\/(splits|status|draws|collection|crm|terms))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const sub = m[2];
      if (!sub && method === 'DELETE') { await deleteDeal(repo, id, me.repId); return json(null); }
      if (!sub) return json(await detail(id));
      if (sub === 'terms') await updateTerms(repo, id, body as never, me.repId);
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
