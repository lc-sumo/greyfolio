import { Router } from 'express';
import { repOptions } from '@greystone/commission';
import { HttpError, currentUser, requireRole } from '../auth/middleware.js';
import { adminDealDetail, adminDealRow, adminRenewals } from '../admin-views.js';
import { adminMerchants, adminOverview, merchantKey } from '../analytics-views.js';
import type { Repo } from '../repo.js';
import { addDraw, createDeal, deleteClawback, deleteDeal, deleteDraw, linkRenewal, recordClawback, updateClawback, updateContact, updateDealMetadata, updateDrawTerms, setCollection, setCrmId, setDealStatus, updateSplits, updateTerms } from '../services/deals.js';
import { addFile, addNote, fetchFile, removeFile, removeNote } from '../services/notes.js';
import { previewIncrementGridUpload } from '../services/increment-grid-import.js';
import { notifyClawback, type NotifyDeps } from '../services/notify.js';
import { createAdjustment, reverseAdjustment } from '../services/wallet-adjustments.js';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Master board and deal writes. Reading is admin-only too: these payloads
 * carry house net, referral fees and every rep's name. Reps cannot add
 * their own deals — there is no rep-facing write route at all.
 */
export function adminDealsRouter(repo: Repo, notify?: Omit<NotifyDeps, 'repo'>): Router {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/wallet-adjustments', async (_req, res) => {
    const [adjustments, deals, reps] = await Promise.all([repo.listWalletAdjustments(), repo.loadContext(), repo.listReps()]);
    const names = new Map(reps.map((r) => [r.id, r.name]));
    const businesses = new Map(deals.deals.map((d) => [d.id, d.business]));
    res.json(adjustments.map((a) => ({ ...a, repName: names.get(a.repId) ?? a.repId, business: businesses.get(a.dealId) ?? a.dealId })));
  });
  r.get('/deals/:id/wallet-adjustments', async (req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    const deal = ctx.deals.find((d) => d.id === String(req.params.id));
    if (!deal) throw new HttpError(404, 'Deal not found');
    const names = new Map(reps.map((r) => [r.id, r.name]));
    res.json((ctx.adjustments ?? []).filter((a) => a.dealId === deal.id).map((a) => ({ ...a, dealId: deal.id, business: deal.business, repId: a.repId, repName: names.get(a.repId) ?? a.repId })));
  });
  r.post('/wallet-adjustments', async (req, res) => {
    const actor = currentUser(req)!.repId;
    const body = req.body ?? {};
    let created;
    try { created = await createAdjustment(repo, { ...body, idempotencyKey: String(body.idempotencyKey ?? ''), dealId: String(body.dealId ?? ''), repId: String(body.repId ?? '') }, actor); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Invalid wallet adjustment'); }
    await repo.writeAudit({ actorRepId: actor, action: 'wallet.adjustment.create', targetRepId: created.repId, path: req.path, detail: { id: created.id, dealId: created.dealId, amount: created.amount } });
    res.status(201).json(created);
  });
  r.post('/deals/:id/wallet-adjustments', async (req, res) => {
    const actor = currentUser(req)!.repId;
    let created;
    try { created = await createAdjustment(repo, { ...req.body, dealId: String(req.params.id), idempotencyKey: String(req.body?.idempotencyKey ?? ''), repId: String(req.body?.repId ?? '') }, actor); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Invalid wallet adjustment'); }
    await repo.writeAudit({ actorRepId: actor, action: 'wallet.adjustment.create', targetRepId: created.repId, path: req.path, detail: { id: created.id, dealId: created.dealId, amount: created.amount, reason: created.reason } });
    res.status(201).json(created);
  });
  r.post('/wallet-adjustments/:id/reverse', async (req, res) => {
    const actor = currentUser(req)!.repId;
    let created;
    try { created = await reverseAdjustment(repo, String(req.params.id), String(req.body?.idempotencyKey ?? ''), req.body?.reason, actor); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Invalid reversal'); }
    await repo.writeAudit({ actorRepId: actor, action: 'wallet.adjustment.reverse', targetRepId: created.repId, path: req.path, detail: { id: created.id, reversalOf: created.reversalOf, dealId: created.dealId, reason: created.reason } });
    res.status(201).json(created);
  });
  r.post('/deals/:dealId/wallet-adjustments/:id/reverse', async (req, res) => {
    const actor = currentUser(req)!.repId;
    const dealId = String(req.params.dealId);
    const original = (await repo.listWalletAdjustments()).find((a) => a.id === String(req.params.id));
    if (!original) throw new HttpError(404, 'Adjustment not found');
    if (original.dealId !== dealId) throw new HttpError(400, 'Adjustment does not belong to this deal');
    let created;
    try { created = await reverseAdjustment(repo, String(req.params.id), String(req.body?.idempotencyKey ?? ''), req.body?.reason, actor); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Invalid reversal'); }
    await repo.writeAudit({ actorRepId: actor, action: 'wallet.adjustment.reverse', targetRepId: created.repId, path: req.path, detail: { id: created.id, reversalOf: created.reversalOf, dealId: created.dealId, reason: created.reason } });
    res.status(201).json(created);
  });

  r.get('/settings', async (_req, res) => {
    res.json(await repo.getSettings());
  });

  r.get('/merchants', async (_req, res) => {
    const [ctx, settings, reps] = await Promise.all([repo.loadContext(), repo.getSettings(), repo.listReps()]);
    res.json({ merchants: adminMerchants(ctx, settings, today(), reps) });
  });
  /** One merchant's whole history: notes across every deal, open tasks, files. Key = merchant email, or business:<name>. */
  r.get('/merchants/:key', async (req, res) => {
    const key = String(req.params.key).toLowerCase();
    const [ctx, settings, reps] = await Promise.all([repo.loadContext(), repo.getSettings(), repo.listReps()]);
    const row = adminMerchants(ctx, settings, today(), reps).find((m) => merchantKey({ merchantEmail: m.email, business: m.business }) === key);
    if (!row) throw new HttpError(404, 'Merchant not found');
    const ids = row.deals.map((d) => d.id);
    const name = new Map(reps.map((r) => [r.id, r.name]));
    const [notes, tasks, files] = await Promise.all([
      Promise.all(ids.map((id) => repo.listNotes(id))).then((x) => x.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
      Promise.all(ids.map((id) => repo.listTasks({ dealId: id }))).then((x) => x.flat().filter((t) => t.status === 'open')),
      Promise.all(ids.map((id) => repo.listFiles(id))).then((x) => x.flat()),
    ]);
    res.json({ merchant: row, notes: notes.map((n) => ({ ...n, author: name.get(n.authorRepId) ?? n.authorRepId })), tasks: tasks.map((t) => ({ ...t, repName: name.get(t.repId) ?? t.repId })), files });
  });

  r.get('/overview', async (req, res) => {
    const t = today();
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : t;
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : `${to.slice(0, 4)}-01-01`;
    if (from > to) throw new HttpError(400, 'from must not be after to');
    const [ctx, reps, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings()]);
    res.json(adminOverview(ctx, reps, settings, from, to, t));
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
  r.post('/deals/increment-grid/preview', async (req, res) => {
    const planned = req.body?.planned === null || req.body?.planned === undefined ? null : Number(req.body.planned);
    res.json(await previewIncrementGridUpload(req.body ?? {}, Number.isFinite(planned) ? planned : null));
  });

  const detailOf = async (id: string) => {
    const [ctx, reps, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings()]);
    const deal = ctx.deals.find((d) => d.id === id);
    if (!deal) throw new HttpError(404, 'Deal not found');
    return adminDealDetail(deal, ctx, reps, settings, today());
  };

  r.patch('/deals/:id/terms', async (req, res) => {
    await updateTerms(repo, String(req.params.id), req.body ?? {}, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.post('/deals/:id/increment-grid/preview', async (req, res) => {
    const ctx = await repo.loadContext();
    const deal = ctx.deals.find((d) => d.id === String(req.params.id));
    if (!deal) throw new HttpError(404, 'Deal not found');
    res.json(await previewIncrementGridUpload(req.body ?? {}, deal.funded));
  });
  r.delete('/deals/:id', async (req, res) => {
    await deleteDeal(repo, String(req.params.id), currentUser(req)!.repId);
    res.status(204).end();
  });
  const saveSplits = async (req: Parameters<Router>[0], res: Parameters<Router>[1]) => {
    await updateSplits(repo, String(req.params.id), req.body, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  };
  r.patch('/deals/:id/splits', saveSplits);
  r.post('/deals/:id/splits', saveSplits);
  r.patch('/deals/:id/status', async (req, res) => {
    await setDealStatus(repo, String(req.params.id), String(req.body?.dealStatus ?? ''), currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.patch('/deals/:id/renewal', async (req, res) => {
    await linkRenewal(repo, String(req.params.id), req.body?.renewedFromId, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.patch('/deals/:id/crm', async (req, res) => {
    await setCrmId(repo, String(req.params.id), req.body?.crmId === null ? null : String(req.body?.crmId ?? ''), currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.patch('/deals/:id/metadata', async (req, res) => {
    await updateDealMetadata(repo, String(req.params.id), req.body ?? {}, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.post('/deals/:id/draws', async (req, res) => {
    await addDraw(repo, String(req.params.id), req.body, currentUser(req)!.repId);
    res.status(201).json(await detailOf(String(req.params.id)));
  });
  /** Merchant identity can be corrected on any deal, paid or not; optionally across every deal on that email. */
  r.patch('/deals/:id/contact', async (req, res) => {
    const r2 = await updateContact(repo, String(req.params.id), req.body ?? {}, currentUser(req)!.repId);
    res.json({ ...(await detailOf(String(req.params.id))), updatedDeals: r2.updated });
  });
  r.patch('/deals/:id/draws/:ref', async (req, res) => {
    await updateDrawTerms(repo, String(req.params.id), String(req.params.ref), req.body ?? {}, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.patch('/deals/:id/clawbacks/:cid', async (req, res) => {
    await updateClawback(repo, String(req.params.id), String(req.params.cid), req.body ?? {}, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.delete('/deals/:id/clawbacks/:cid', async (req, res) => {
    await deleteClawback(repo, String(req.params.id), String(req.params.cid), currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.delete('/deals/:id/draws/:ref', async (req, res) => {
    await deleteDraw(repo, String(req.params.id), String(req.params.ref), currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });
  r.post('/deals/:id/collection', async (req, res) => {
    await setCollection(repo, String(req.params.id), req.body, currentUser(req)!.repId);
    res.json(await detailOf(String(req.params.id)));
  });

  /** Record a clawback; every rep with a slice gets an email when mail is on. */
  r.post('/deals/:id/clawbacks', async (req, res) => {
    const actor = currentUser(req)!.repId;
    const cb = await recordClawback(repo, String(req.params.id), req.body ?? {}, actor);
    const mailed = notify ? await notifyClawback({ repo, ...notify }, cb, actor) : { sent: 0 };
    res.status(201).json({ ...(await detailOf(String(req.params.id))), notified: mailed.sent });
  });

  /* ---- Notes: a history, newest first ---- */
  const notesOf = async (id: string) => {
    const [notes, reps] = await Promise.all([repo.listNotes(id), repo.listReps()]);
    const name = new Map(reps.map((x) => [x.id, x.name]));
    return notes.map((n) => ({ ...n, author: name.get(n.authorRepId) ?? n.authorRepId }));
  };
  r.get('/deals/:id/notes', async (req, res) => res.json({ notes: await notesOf(String(req.params.id)) }));
  r.post('/deals/:id/notes', async (req, res) => {
    await addNote(repo, String(req.params.id), req.body?.body, currentUser(req)!.repId);
    res.status(201).json({ notes: await notesOf(String(req.params.id)) });
  });
  r.delete('/deals/:id/notes/:noteId', async (req, res) => {
    await removeNote(repo, String(req.params.id), String(req.params.noteId), currentUser(req)!.repId);
    res.json({ notes: await notesOf(String(req.params.id)) });
  });

  /* ---- Files: contracts and confirmations, inline and capped ---- */
  const filesOf = async (id: string) => {
    const [files, reps] = await Promise.all([repo.listFiles(id), repo.listReps()]);
    const name = new Map(reps.map((x) => [x.id, x.name]));
    return files.map((f) => ({ ...f, uploadedByName: name.get(f.uploadedBy) ?? f.uploadedBy }));
  };
  r.get('/deals/:id/files', async (req, res) => res.json({ files: await filesOf(String(req.params.id)) }));
  r.post('/deals/:id/files', async (req, res) => {
    await addFile(repo, String(req.params.id), req.body ?? {}, currentUser(req)!.repId);
    res.status(201).json({ files: await filesOf(String(req.params.id)) });
  });
  r.get('/deals/:id/files/:fileId', async (req, res) => {
    const f = await fetchFile(repo, String(req.params.id), String(req.params.fileId));
    res.setHeader('content-type', f.mime);
    res.setHeader('content-disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.name)}"`);
    res.setHeader('cache-control', 'private, max-age=0');
    res.send(Buffer.from(f.data, 'base64'));
  });
  r.delete('/deals/:id/files/:fileId', async (req, res) => {
    await removeFile(repo, String(req.params.id), String(req.params.fileId), currentUser(req)!.repId);
    res.json({ files: await filesOf(String(req.params.id)) });
  });

  return r;
}
