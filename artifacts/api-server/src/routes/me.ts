import { Router } from 'express';
import { repDeals } from '@greystone/commission';
import { HttpError, requireAuth, resolveScope, scopeOf } from '../auth/middleware.js';
import type { Repo } from '../repo.js';
import { leaderboard, repClawbackViews, repDealView, repMonthly, repStatements, repWallet } from '../scope.js';

/**
 * The rep portal. Every handler reads `scopeOf(req).effectiveRepId` — the
 * signed-in rep, or the View-as target — and returns rep-safe projections only.
 */
export function meRouter(repo: Repo): Router {
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

  r.get('/wallet', async (req, res) => {
    const ctx = await repo.loadContext();
    res.json(repWallet(ctx, scopeOf(req).effectiveRepId));
  });

  r.get('/deals', async (req, res) => {
    const repId = scopeOf(req).effectiveRepId;
    const ctx = await repo.loadContext();
    const q = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    let rows = repDeals(ctx.deals, repId).map((d) => repDealView(d, repId, ctx.lines, ctx.clawbacks));
    if (q) rows = rows.filter((d) => `${d.id} ${d.business} ${d.lender} ${d.product}`.toLowerCase().includes(q));
    if (status !== 'all') rows = rows.filter((d) => d.payoutStatus === status || d.commissionStatus === status);
    res.json({ count: rows.length, deals: rows });
  });

  r.get('/deals/:id', async (req, res) => {
    const repId = scopeOf(req).effectiveRepId;
    const ctx = await repo.loadContext();
    const deal = ctx.deals.find((d) => d.id === req.params.id);
    // A deal the rep is not on is indistinguishable from one that does not exist.
    if (!deal || !repDeals([deal], repId).length) throw new HttpError(404, 'Deal not found');
    const view = repDealView(deal, repId, ctx.lines, ctx.clawbacks);
    const payments = ctx.lines
      .filter((l) => l.repId === repId && l.dealId === deal.id)
      .map((l) => ({ role: l.role, segmentKey: l.segmentKey, amount: l.amount, paidAt: l.paidAt, runId: l.runId }))
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt));
    res.json({ ...view, payments });
  });

  r.get('/clawbacks', async (req, res) => {
    const ctx = await repo.loadContext();
    res.json({ clawbacks: repClawbackViews(ctx, scopeOf(req).effectiveRepId) });
  });

  r.get('/statements', async (req, res) => {
    const [ctx, runs] = await Promise.all([repo.loadContext(), repo.listRuns()]);
    res.json({ statements: repStatements(ctx, runs, scopeOf(req).effectiveRepId) });
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
