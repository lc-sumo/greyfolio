import { Router } from 'express';
import { repDeals } from '@greystone/commission';
import { HttpError, requireAuth, resolveScope, scopeOf } from '../auth/middleware.js';
import type { Repo } from '../repo.js';
import { changeOwnPassword } from '../services/passwords.js';
import { beginTotp, disableTotp, enableTotp, totpStatus } from '../services/twofactor.js';
import { repQuestion, type NotifyDeps } from '../services/notify.js';
import { leaderboard, repClawbackViews, repDashboard, repDealView, repMonthly, repPayHistory, repPayHistoryCsv, repRenewals, repStatements, repWallet } from '../scope.js';
import { annualReport } from '../payroll-views.js';
import { addRepFile, fetchRepFile } from '../services/notes.js';
import { createTask, logOutcome, merchantPreview, sendMerchantEmail, taskViews } from '../services/playbooks.js';
import { TASK_OUTCOMES } from '../services/playbook-rules.js';
import { issueCalendarToken, revokeCalendarToken } from '../services/calendar.js';
import { forgetDeviceCookie, readCookie, DEVICE_COOKIE } from '../auth/devices.js';
import type { Geo } from '../services/geo.js';

/**
 * The rep portal. Every handler reads `scopeOf(req).effectiveRepId` — the
 * signed-in rep, or the View-as target — and returns rep-safe projections only.
 */
export function meRouter(repo: Repo, appName = 'Greystone Commission Portal', notify?: Omit<NotifyDeps, 'repo'>, extras: { geo?: Geo; secureCookies?: boolean } = {}): Router {
  const r = Router();
  r.use(requireAuth, resolveScope(repo));

  r.get('/', async (req, res) => {
    const s = scopeOf(req);
    const rep = await repo.findRep(s.effectiveRepId);
    if (!rep) throw new HttpError(404, 'Rep not found');
    res.json({
      rep: { id: rep.id, name: rep.name, email: rep.email, role: rep.role, active: rep.active },
      viewAs: s.viewAs,
      actor: s.viewAs ? { id: s.actor.repId, name: s.actor.name, role: s.actor.role } : null,
    });
  });

  /** Change my own password — never under View as. */
  r.post('/password', async (req, res) => {
    const scope = scopeOf(req);
    if (scope.viewAs) throw new HttpError(403, 'Passwords can only be changed by the account holder');
    const { since } = await changeOwnPassword(repo, scope.actor.repId, req.body?.current, req.body?.next);
    // This device stays signed in; every other one is cut off.
    req.session = { ...req.session, user: { ...scope.actor, since } };
    res.json({ ok: true });
  });

  /** Two-factor sign-in — always the account holder, never under View as. */
  const self = (req: Parameters<typeof scopeOf>[0]) => {
    const scope = scopeOf(req);
    if (scope.viewAs) throw new HttpError(403, 'Two-factor settings belong to the account holder');
    return scope.actor.repId;
  };
  r.get('/totp', async (req, res) => res.json(await totpStatus(repo, self(req))));
  r.post('/totp/setup', async (req, res) => res.json(await beginTotp(repo, self(req), appName)));
  r.post('/totp/enable', async (req, res) => {
    await enableTotp(repo, self(req), req.body?.code);
    res.json({ ok: true, enabled: true });
  });
  /** Browsers remembered after a two-factor sign-in. "This device" is the one making the request. */
  r.get('/devices', async (req, res) => {
    const scope = scopeOf(req);
    const list = await repo.listTrustedDevices(scope.effectiveRepId);
    const cookie = readCookie(req, DEVICE_COOKIE);
    const thisId = cookie ? cookie.slice(0, cookie.indexOf('.')) : null;
    const where = extras.geo ? await extras.geo.labels(list.map((d) => d.ip)) : new Map<string, string>();
    res.json({ devices: list.map((d) => ({ id: d.id, label: d.label, ip: d.ip, location: d.ip ? where.get(d.ip) ?? null : null, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, expiresAt: d.expiresAt, current: d.id === thisId })) });
  });
  r.delete('/devices/:id', async (req, res) => {
    const scope = scopeOf(req);
    if (scope.viewAs) throw new HttpError(403, 'Devices belong to the account holder');
    const d = (await repo.listTrustedDevices(scope.actor.repId)).find((x) => x.id === req.params.id);
    if (!d) throw new HttpError(404, 'Device not found');
    await repo.deleteTrustedDevice(d.id);
    await repo.writeAudit({ actorRepId: scope.actor.repId, action: 'rep.device', targetRepId: null, path: `/api/me/devices/${d.id}`, detail: { forgot: true, label: d.label } });
    const cookie = readCookie(req, DEVICE_COOKIE);
    if (cookie && cookie.startsWith(`${d.id}.`)) forgetDeviceCookie(res, extras.secureCookies ?? false);
    res.json({ ok: true });
  });
  r.delete('/devices', async (req, res) => {
    const scope = scopeOf(req);
    if (scope.viewAs) throw new HttpError(403, 'Devices belong to the account holder');
    await repo.deleteTrustedDevices(scope.actor.repId);
    await repo.writeAudit({ actorRepId: scope.actor.repId, action: 'rep.device', targetRepId: null, path: '/api/me/devices', detail: { forgotAll: true } });
    forgetDeviceCookie(res, extras.secureCookies ?? false);
    res.json({ ok: true });
  });
  r.post('/totp/disable', async (req, res) => {
    await disableTotp(repo, self(req), req.body?.code);
    res.json({ ok: true, enabled: false });
  });

  r.get('/wallet', async (req, res) => {
    const ctx = await repo.loadContext();
    res.json(repWallet(ctx, scopeOf(req).effectiveRepId));
  });

  r.get('/dashboard', async (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today;
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : `${to.slice(0, 4)}-01-01`;
    if (from > to) throw new HttpError(400, 'from must not be after to');
    const [ctx, reps, runs, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.listRuns(), repo.getSettings()]);
    res.json(repDashboard(ctx, reps, runs, scopeOf(req).effectiveRepId, from, to, settings.payroll?.cycle ?? 'Twice monthly', settings));
  });

  r.get('/deals', async (req, res) => {
    const repId = scopeOf(req).effectiveRepId;
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    const q = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    let rows = repDeals(ctx.deals, repId).map((d) => repDealView(d, repId, ctx.lines, ctx.clawbacks, settings));
    if (q) rows = rows.filter((d) => `${d.id} ${d.business} ${d.lender} ${d.product}`.toLowerCase().includes(q));
    if (status !== 'all') rows = rows.filter((d) => d.payoutStatus === status || d.commissionStatus === status);
    res.json({ count: rows.length, deals: rows });
  });

  r.get('/deals/:id', async (req, res) => {
    const repId = scopeOf(req).effectiveRepId;
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    const deal = ctx.deals.find((d) => d.id === req.params.id);
    // A deal the rep is not on is indistinguishable from one that does not exist.
    if (!deal || !repDeals([deal], repId).length) throw new HttpError(404, 'Deal not found');
    const view = repDealView(deal, repId, ctx.lines, ctx.clawbacks, settings);
    const payments = ctx.lines
      .filter((l) => l.repId === repId && l.dealId === deal.id)
      .map((l) => ({ role: l.role, segmentKey: l.segmentKey, unit: /\|u(\d+)(?:#\d+)?$/.test(l.key) ? (/\|u0(?:#\d+)?$/.test(l.key) ? 'Upfront' : `Increment ${/\|u(\d+)(?:#\d+)?$/.exec(l.key)![1]}`) : null, amount: l.amount, paidAt: l.paidAt, runId: l.runId }))
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt));
    res.json({ ...view, payments });
  });

  /** Ask the admins about one of my deals — a note on the deal plus an email. Only for deals the rep earned on. */
  r.post('/deals/:id/question', async (req, res) => {
    const s = scopeOf(req);
    if (s.viewAs) throw new HttpError(403, 'Questions come from the rep, not from View as');
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Write your question first');
    if (text.length > 2000) throw new HttpError(400, 'Keep it under 2,000 characters');
    const ctx = await repo.loadContext();
    if (!repDeals(ctx.deals, s.actor.repId).some((d) => d.id === req.params.id)) throw new HttpError(404, 'Deal not found');
    const r2 = await repQuestion({ repo, mailer: notify?.mailer ?? { kind: 'off', live: false, send: async () => ({ ok: false }) }, origin: notify?.origin ?? '', appName: notify?.appName ?? appName }, s.actor.repId, String(req.params.id), text);
    res.status(201).json({ ok: true, emailed: r2.sent });
  });

  r.get('/clawbacks', async (req, res) => {
    const ctx = await repo.loadContext();
    res.json({ clawbacks: repClawbackViews(ctx, scopeOf(req).effectiveRepId) });
  });

  r.get('/statements', async (req, res) => {
    const [ctx, runs] = await Promise.all([repo.loadContext(), repo.listRuns()]);
    res.json({ statements: repStatements(ctx, runs, scopeOf(req).effectiveRepId) });
  });

  /** Pay history: every ledger row — when, how much, which deal. */
  r.get('/payments', async (req, res) => {
    const [ctx, runs] = await Promise.all([repo.loadContext(), repo.listRuns()]);
    res.json(repPayHistory(ctx, runs, scopeOf(req).effectiveRepId));
  });
  r.get('/payments.csv', async (req, res) => {
    const [ctx, runs] = await Promise.all([repo.loadContext(), repo.listRuns()]);
    res.type('text/csv').attachment('my-pay-history.csv').send(repPayHistoryCsv(ctx, runs, scopeOf(req).effectiveRepId));
  });
  /** Year-end totals for the rep: what a 1099 will show. */
  r.get('/annual', async (req, res) => {
    const y = Number(req.query.year ?? new Date().getUTCFullYear());
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, 'year must be a four-digit year');
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    const id = scopeOf(req).effectiveRepId;
    const me = reps.find((x) => x.id === id);
    const row = annualReport(ctx, reps, y).rows.find((x) => x.repId === id) ?? { repId: id, name: me?.name ?? id, email: me?.email ?? '', active: me?.active ?? true, grossPaid: 0, recovered: 0, cash: 0, payouts: 0, deals: 0 };
    const years = [...new Set(ctx.lines.filter((l) => l.repId === id).map((l) => l.paidAt.slice(0, 4)))].sort().reverse();
    res.json({ year: y, years, ...row });
  });
  /* ---- Tasks: what the playbooks (or an admin, or I) put on my list ---- */
  const today = () => new Date().toISOString().slice(0, 10);
  r.get('/tasks', async (req, res) => {
    const status = req.query.status === 'open' || req.query.status === 'done' ? req.query.status : undefined;
    res.json({ tasks: await taskViews(repo, { repId: scopeOf(req).effectiveRepId, status }, today()), outcomes: TASK_OUTCOMES, today: today() });
  });
  r.post('/deals/:id/tasks', async (req, res) => {
    const s = scopeOf(req);
    if (s.viewAs) throw new HttpError(403, 'Tasks are added by the rep, not from View as');
    const ctx = await repo.loadContext();
    if (!repDeals(ctx.deals, s.actor.repId).some((d) => d.id === req.params.id)) throw new HttpError(404, 'Deal not found');
    res.status(201).json(await createTask(repo, { dealId: String(req.params.id), repId: s.actor.repId, title: req.body?.title, dueDate: req.body?.dueDate }, s.actor.repId, today()));
  });
  r.patch('/tasks/:id', async (req, res) => {
    const s = scopeOf(req);
    if (s.viewAs) throw new HttpError(403, 'Outcomes are logged by the rep, not from View as');
    res.json(await logOutcome(repo, String(req.params.id), req.body ?? {}, s.actor.repId, today(), { asAdmin: false }));
  });

  /* ---- Private calendar feed ---- */
  const feedUrl = (token: string) => `${notify?.origin ?? ''}/calendar/${token}.ics`;
  r.get('/calendar', async (req, res) => {
    const s = scopeOf(req);
    const token = await repo.getCalendarToken(s.effectiveRepId);
    res.json({ url: token && !s.viewAs ? feedUrl(token) : null, enabled: !!token });
  });
  r.post('/calendar', async (req, res) => {
    const s = scopeOf(req);
    if (s.viewAs) throw new HttpError(403, 'The feed belongs to the account holder');
    res.json({ url: feedUrl(await issueCalendarToken(repo, s.actor.repId)), enabled: true });
  });
  r.delete('/calendar', async (req, res) => {
    const s = scopeOf(req);
    if (s.viewAs) throw new HttpError(403, 'The feed belongs to the account holder');
    await revokeCalendarToken(repo, s.actor.repId);
    res.json({ url: null, enabled: false });
  });

  /* ---- Email the merchant from a template, under my name ---- */
  const myDeal = async (req: Parameters<Router>[0]) => {
    const s = scopeOf(req);
    const ctx = await repo.loadContext();
    const deal = repDeals(ctx.deals, s.actor.repId).find((d) => d.id === req.params.id);
    if (!deal) throw new HttpError(404, 'Deal not found');
    return { s, deal };
  };
  const mayEmail = async (repId: string) => {
    const [settings, rep] = await Promise.all([repo.getSettings(), repo.findRep(repId)]);
    return settings.permissions.merchantEmail && rep?.perms?.merchantEmail !== false;
  };
  r.get('/templates', async (req, res) => res.json({ merchant: (await repo.getSettings()).templates.merchant, live: !!notify && (notify.mailer.live || notify.mailer.kind === 'log'), allowed: await mayEmail(scopeOf(req).effectiveRepId) }));
  r.get('/deals/:id/merchant-email/preview', async (req, res) => {
    const { s, deal } = await myDeal(req);
    if (!(await mayEmail(s.actor.repId))) throw new HttpError(403, 'Emailing merchants is turned off for your account — ask an admin');
    res.json(await merchantPreview(repo, deal, s.actor.repId, String(req.query.template ?? ''), today(), appName));
  });
  r.post('/deals/:id/merchant-email', async (req, res) => {
    const { s, deal } = await myDeal(req);
    if (s.viewAs) throw new HttpError(403, 'Merchant emails go out from the rep, not from View as');
    if (!(await mayEmail(s.actor.repId))) throw new HttpError(403, 'Emailing merchants is turned off for your account — ask an admin');
    res.json(await sendMerchantEmail({ repo, mailer: notify?.mailer ?? { kind: 'off', live: false, send: async () => ({ ok: false }) }, origin: notify?.origin ?? '', appName: notify?.appName ?? appName }, deal, s.actor.repId, req.body ?? {}, today()));
  });

  /** My own files (W-9): a rep can add and read theirs; only an admin removes. */
  r.get('/files', async (req, res) => {
    const scope = scopeOf(req);
    res.json({ files: await repo.listRepFiles(scope.effectiveRepId) });
  });
  r.post('/files', async (req, res) => {
    const scope = scopeOf(req);
    if (scope.viewAs) throw new HttpError(403, 'Files can only be added by the account holder');
    await addRepFile(repo, scope.actor.repId, req.body ?? {}, scope.actor.repId);
    res.status(201).json({ files: await repo.listRepFiles(scope.actor.repId) });
  });
  r.get('/files/:fileId', async (req, res) => {
    const f = await fetchRepFile(repo, scopeOf(req).effectiveRepId, String(req.params.fileId));
    res.setHeader('content-type', f.mime);
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
    res.setHeader('cache-control', 'private, max-age=0');
    res.send(Buffer.from(f.data, 'base64'));
  });

  /** The rep's own renewals, so they know when to follow up. Merchant contact included; other reps' names are not. */
  r.get('/renewals', async (req, res) => {
    const [ctx, thresholds] = await Promise.all([repo.loadContext(), repo.getSetting<{ renewalMark: number; additionalCapitalAfterDays: number }>('thresholds')]);
    const t = { renewalMark: thresholds?.renewalMark ?? 0.4, additionalCapitalAfterDays: thresholds?.additionalCapitalAfterDays ?? 30 };
    res.json({ renewals: repRenewals(ctx, scopeOf(req).effectiveRepId, t, new Date().toISOString().slice(0, 10)), thresholds: t });
  });

  r.get('/leaderboard', async (req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    res.json({ rows: leaderboard(ctx, reps, scopeOf(req).effectiveRepId) });
  });

  r.get('/monthly', async (req, res) => {
    const months = typeof req.query.months === 'string' ? req.query.months.split(',').filter((m) => /^\d{4}-\d{2}$/.test(m)) : [];
    if (!months.length) throw new HttpError(400, 'months=YYYY-MM,YYYY-MM is required');
    const ctx = await repo.loadContext();
    res.json({ series: repMonthly(ctx, scopeOf(req).effectiveRepId, months) });
  });

  return r;
}
