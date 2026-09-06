import { Router } from 'express';
import { HttpError, currentUser, requireRole } from '../auth/middleware.js';
import type { Repo } from '../repo.js';
import { createRep, createTeam, deleteTeam, saveCrm, saveLenders, saveLists, saveNotifications, savePartners, savePayroll, savePortal, saveProducts, saveSecurity, saveThresholds, updateRep, updateTeam, usage } from '../services/settings.js';
import { beginInvite, setRepPassword } from '../services/passwords.js';
import type { NotifyDeps } from '../services/notify.js';
import { commitImport, previewImport } from '../services/import.js';
import { sheetSource } from '../services/sheet-source.js';
import { commitRemittance, previewRemittance } from '../services/remittance.js';

/** Settings writes: lenders, partners, product rules, thresholds, CRM, teams, reps. Admin only. */
export function adminSettingsRouter(repo: Repo, notify: Omit<NotifyDeps, 'repo'>): Router {
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
  r.put('/settings/portal', async (req, res) => res.json({ portal: await savePortal(repo, req.body ?? {}, actor(req)) }));
  r.put('/settings/notifications', async (req, res) => res.json({ notifications: await saveNotifications(repo, req.body ?? {}, actor(req)) }));
  r.put('/settings/security', async (req, res) => res.json({ security: await saveSecurity(repo, req.body ?? {}, actor(req)) }));
  r.put('/settings/lists', async (req, res) => res.json({ lists: await saveLists(repo, req.body ?? {}, actor(req)) }));

  r.post('/teams', async (req, res) => res.status(201).json(await createTeam(repo, req.body ?? {}, actor(req))));
  r.patch('/teams/:id', async (req, res) => res.json(await updateTeam(repo, String(req.params.id), req.body ?? {}, actor(req))));
  r.delete('/teams/:id', async (req, res) => {
    await deleteTeam(repo, String(req.params.id), actor(req));
    res.status(204).end();
  });

  /** Import the tracker's FUNDED DEALS tab (CSV text in the body). */
  /** Body: `{ csv }` (text) or `{ xlsx }` (base64 of the Google Sheets → Download → Microsoft Excel file). */
  const importOpts = async (req: Parameters<Router>[0]) => ({ skipExisting: !!req.body?.skipExisting, grid: await sheetSource(req.body) });
  r.post('/import/preview', async (req, res) => res.json(await previewImport(repo, String(req.body?.csv ?? ''), await importOpts(req))));
  r.post('/import', async (req, res) => res.status(201).json(await commitImport(repo, String(req.body?.csv ?? ''), actor(req), await importOpts(req))));
  /** Lender remittance report (CSV): match payments to deals and mark increments / dollars received. */
  r.post('/remittance/preview', async (req, res) => res.json(await previewRemittance(repo, String(req.body?.csv ?? ''))));
  r.post('/remittance', async (req, res) => res.status(201).json(await commitRemittance(repo, String(req.body?.csv ?? ''), actor(req))));
  r.post('/reps', async (req, res) => res.status(201).json(await createRep(repo, req.body ?? {}, actor(req))));
  r.patch('/reps/:id', async (req, res) => res.json(await updateRep(repo, String(req.params.id), req.body ?? {}, actor(req))));
  r.post('/reps/:id/password', async (req, res) => res.json(await setRepPassword(repo, String(req.params.id), req.body?.password === null ? null : req.body?.password, actor(req))));
  /** Email the rep a 72-hour set-password link. */
  r.post('/reps/:id/invite', async (req, res) => {
    const { mailer, origin } = notify;
    if (!mailer.live && mailer.kind !== 'log') throw new HttpError(503, 'Email is not set up on this portal (MAIL_PROVIDER) — set a password under Reps instead');
    const settings = await repo.getSettings();
    const appName = settings.portal.company && settings.portal.portal ? `${settings.portal.company} ${settings.portal.portal}` : notify.appName;
    const { token, rep } = await beginInvite(repo, String(req.params.id), actor(req));
    const link = `${origin}/reset?token=${token}`;
    const text = [`Hi ${rep.name.split(' ')[0]},`, '', `You have an account on the ${appName}. Choose your password here — the link works for 72 hours:`, '', link, '', `After that, sign in at ${origin} with ${rep.email}. Your deals, payouts and renewals are all there.`, '', `— ${appName}`].join('\n');
    const sent = await mailer.send({ to: rep.email, subject: `Your ${appName} sign-in`, text });
    await repo.writeAudit({ actorRepId: actor(req), action: 'mail.sent', targetRepId: rep.id, path: `/api/admin/reps/${rep.id}/invite`, detail: { to: rep.email, subject: 'invite', ok: sent.ok, ...(sent.error ? { error: sent.error } : {}) } });
    if (!sent.ok) throw new HttpError(502, `The invite could not be sent: ${sent.error ?? 'mail provider error'}`);
    res.json({ ok: true, email: rep.email });
  });

  return r;
}
