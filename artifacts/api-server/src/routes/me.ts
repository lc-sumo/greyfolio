import { Router } from 'express';
import { repDeals } from '@greystone/commission';
import { HttpError, requireAuth, resolveScope, scopeOf } from '../auth/middleware.js';
import type { Repo } from '../repo.js';
import { changeOwnPassword } from '../services/passwords.js';
import { beginTotp, disableTotp, enableTotp, totpStatus } from '../services/twofactor.js';
import { repQuestion, type NotifyDeps } from '../services/notify.js';
import { leaderboard, repClawbackViews, repDashboard, repDealView, repMonthly, repPayHistory, repRenewals, repStatements, repWallet } from '../scope.js';

/**
 * The rep portal. Every handler reads `scopeOf(req).effectiveRepId` — the
 * signed-in rep, or the View-as target — and returns rep-safe projections only.
 */
export function meRouter(repo: Repo, appName = 'Greystone Commission Portal', notify?: Omit<NotifyDeps, 'repo'>): Router {
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
    await changeOwnPassword(repo, scope.actor.repId, req.body?.current, req.body?.next);
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
