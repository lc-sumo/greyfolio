import { Router } from 'express';
import { currentUser, requireRole } from '../auth/middleware.js';
import type { Repo } from '../repo.js';
import { createRep, createTeam, deleteTeam, saveCrm, saveLenders, savePartners, savePayroll, saveProducts, saveThresholds, updateRep, updateTeam, usage } from '../services/settings.js';
import { setRepPassword } from '../services/passwords.js';
import { commitImport, previewImport } from '../services/import.js';
import { commitRemittance, previewRemittance } from '../services/remittance.js';

/** Settings writes: lenders, partners, product rules, thresholds, CRM, teams, reps. Admin only. */
export function adminSettingsRouter(repo: Repo): Router {
  const r = Router();
  r.use(requireRole('admin'));
  const actor = (req: Parameters<Router>[0]) => currentUser(req)!.repId;

  r.get('/settings/usage', async (_req, res) => res.json(await usage(repo)));
  r.put('/settings/lenders', async (req, res) => res.json({ lenders: await saveLenders(repo, req.body?.lenders, actor(req)) }));
  r.put('/settings/partners', async (req, res) => res.json({ partners: await savePartners(repo, req.body?.partners, actor(req)) }));
  r.put('/settings/products', async (req, res) => res.json({ products: await saveProducts(repo, req.body?.products, actor(req)) }));
  r.put('/settings/thresholds', async (req, res) => res.json({ thresholds: await saveThresholds(repo, req.body ?? {}, actor(req)) }));
  r.put('/settings/crm', async (req, res) => res.json({ crm: await saveCrm(repo, req.body ?? {}, actor(req)) }));
  r.put('/settings/payroll', async (req, res) => res.json({ payroll: await savePayroll(repo, req.body ?? {}, actor(req)) }));

  r.post('/teams', async (req, res) => res.status(201).json(await createTeam(repo, req.body ?? {}, actor(req))));
  r.patch('/teams/:id', async (req, res) => res.json(await updateTeam(repo, String(req.params.id), req.body ?? {}, actor(req))));
  r.delete('/teams/:id', async (req, res) => {
    await deleteTeam(repo, String(req.params.id), actor(req));
    res.status(204).end();
  });

  /** Import the tracker's FUNDED DEALS tab (CSV text in the body). */
  const importOpts = (req: Parameters<Router>[0]) => ({ skipExisting: !!req.body?.skipExisting });
  r.post('/import/preview', async (req, res) => res.json(await previewImport(repo, String(req.body?.csv ?? ''), importOpts(req))));
  r.post('/import', async (req, res) => res.status(201).json(await commitImport(repo, String(req.body?.csv ?? ''), actor(req), importOpts(req))));
  /** Lender remittance report (CSV): match payments to deals and mark increments / dollars received. */
  r.post('/remittance/preview', async (req, res) => res.json(await previewRemittance(repo, String(req.body?.csv ?? ''))));
  r.post('/remittance', async (req, res) => res.status(201).json(await commitRemittance(repo, String(req.body?.csv ?? ''), actor(req))));
  r.post('/reps', async (req, res) => res.status(201).json(await createRep(repo, req.body ?? {}, actor(req))));
  r.patch('/reps/:id', async (req, res) => res.json(await updateRep(repo, String(req.params.id), req.body ?? {}, actor(req))));
  r.post('/reps/:id/password', async (req, res) => res.json(await setRepPassword(repo, String(req.params.id), req.body?.password === null ? null : req.body?.password, actor(req))));

  return r;
}
