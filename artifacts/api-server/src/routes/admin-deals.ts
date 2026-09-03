import { Router } from 'express';
import { repOptions } from '@greystone/commission';
import { HttpError, currentUser, requireRole } from '../auth/middleware.js';
import { adminDealDetail, adminDealRow, adminRenewals } from '../admin-views.js';
import type { Repo } from '../repo.js';
import { addDraw, createDeal, setCollection, setCrmId, setDealStatus, updateSplits } from '../services/deals.js';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Master board and deal writes. Reading is admin-only too: these payloads
 * carry house net, referral fees and every rep's name. Reps cannot add
 * their own deals — there is no rep-facing write route at all.
 */
export function adminDealsRouter(repo: Repo): Router {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/settings', async (_req, res) => {
    res.json(await repo.getSettings());
  });

  r.get('/renewals', async (_req, res) => {
    const [ctx, reps, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings()]);
    res.json({ renewals: adminRenewals(ctx, reps, settings, today()) });
  });

  r.get('/deals', async (req, res) => {
    const [ctx, reps, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings()]);
    const q = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const rep = typeof req.query.rep === 'string' ? req.query.rep : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    let deals = ctx.deals;
    if (rep) deals = deals.filter((d) => d.openerId === rep || d.closerId === rep || d.overrideId === rep);
    let rows = deals.map((d) => adminDealRow(d, ctx, reps, settings, today()));
    if (q) rows = rows.filter((d) => `${d.id} ${d.business} ${d.merchantContact} ${d.merchantEmail} ${d.merchantPhone} ${d.lender} ${d.product}`.toLowerCase().includes(q));
    if (status) rows = rows.filter((d) => d.commissionStatus === status || d.dealStatus === status);
    res.json({
      count: rows.length,
      deals: rows,
      repOptions: { assign: repOptions(reps, 'assign'), edit: repOptions(reps, 'edit') },
    });
  });

  r.get('/deals/:id', async (req, res) => {
    const [ctx, reps, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings()]);
    const deal = ctx.deals.find((d) => d.id === req.params.id);
    if (!deal) throw new HttpError(404, 'Deal not found');
    res.json(adminDealDetail(deal, ctx, reps, settings, today()));
  });

  r.post('/deals', async (req, res) => {
    const deal = await createDeal(repo, req.body, currentUser(req)!.repId);
    const [ctx, reps, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings()]);
    res.status(201).json(adminDealDetail(deal, ctx, reps, settings, today()));
  });

  const detailOf = async (id: string) => {
    const [ctx, reps, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings()]);
    const deal = ctx.deals.find((d) => d.id === id);
    if (!deal) throw new HttpError(404, 'Deal not found');
    return adminDealDetail(deal, ctx, reps, settings, today());
  };

  r.patch('/deals/:id/splits', async (req, res) => {
    await updateSplits(repo, String(req.params.id), req.body, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.patch('/deals/:id/status', async (req, res) => {
    await setDealStatus(repo, String(req.params.id), String(req.body?.dealStatus ?? ''), currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.patch('/deals/:id/crm', async (req, res) => {
    await setCrmId(repo, String(req.params.id), req.body?.crmId === null ? null : String(req.body?.crmId ?? ''), currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.post('/deals/:id/draws', async (req, res) => {
    await addDraw(repo, String(req.params.id), req.body, currentUser(req)!.repId);
    res.status(201).json(await detailOf(String(req.params.id)));
  });
  r.post('/deals/:id/collection', async (req, res) => {
    await setCollection(repo, String(req.params.id), req.body, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });

  return r;
}
