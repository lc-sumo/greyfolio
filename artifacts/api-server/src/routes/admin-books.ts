import { Router } from 'express';
import { currentUser, requireRole } from '../auth/middleware.js';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';
import { booksCsv, cashView, exceptions, markPartnerPaid, partnerPayables, receivables } from '../services/books.js';
import { addRepFile, fetchRepFile, removeRepFile } from '../services/notes.js';
import { scorecards } from '../services/scorecards.js';

const today = () => new Date().toISOString().slice(0, 10);

/** Bookkeeping: receivables, partner payables, the cash view and its export, exceptions; rep files. Admin only. */
export function adminBooksRouter(repo: Repo): Router {
  const r = Router();
  r.use(requireRole('admin'));
  const actor = (req: Parameters<Router>[0]) => currentUser(req)!.repId;
  const yearOf = (req: Parameters<Router>[0]) => {
    const y = Number(req.query.year ?? new Date().getUTCFullYear());
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, 'year must be a four-digit year');
    return y;
  };

  r.get('/books/receivables', async (_req, res) => {
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    res.json(receivables(ctx, settings, today()));
  });
  r.get('/books/partners', async (_req, res) => {
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    res.json(partnerPayables(ctx, settings));
  });
  r.post('/books/partners/pay', async (req, res) => res.json(await markPartnerPaid(repo, req.body ?? {}, actor(req))));
  r.get('/books/cash', async (req, res) => res.json(cashView(await repo.loadContext(), yearOf(req))));
  r.get('/books/cash.csv', async (req, res) => {
    const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
    const y = yearOf(req);
    res.type('text/csv').attachment(`books-${y}.csv`).send(booksCsv(ctx, reps, y));
  });
  r.get('/books/exceptions', async (_req, res) => {
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    res.json(exceptions(ctx, settings, today()));
  });

  r.get('/scorecards', async (req, res) => {
    const [ctx, reps, teams, settings, tasks] = await Promise.all([repo.loadContext(), repo.listReps(), repo.listTeams(), repo.getSettings(), repo.listTasks()]);
    res.json({ year: yearOf(req), rows: scorecards(ctx, reps, teams, settings, tasks, yearOf(req), today()) });
  });

  /* ---- Rep files (W-9, agreements) ---- */
  const filesOf = async (repId: string) => {
    const [files, reps] = await Promise.all([repo.listRepFiles(repId), repo.listReps()]);
    const name = new Map(reps.map((x) => [x.id, x.name]));
    return files.map((f) => ({ ...f, uploadedByName: name.get(f.uploadedBy) ?? f.uploadedBy }));
  };
  r.get('/reps/:id/files', async (req, res) => res.json({ files: await filesOf(String(req.params.id)) }));
  r.post('/reps/:id/files', async (req, res) => {
    await addRepFile(repo, String(req.params.id), req.body ?? {}, actor(req));
    res.status(201).json({ files: await filesOf(String(req.params.id)) });
  });
  r.get('/reps/:id/files/:fileId', async (req, res) => {
    const f = await fetchRepFile(repo, String(req.params.id), String(req.params.fileId));
    res.setHeader('content-type', f.mime);
    res.setHeader('content-disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.name)}"`);
    res.setHeader('cache-control', 'private, max-age=0');
    res.send(Buffer.from(f.data, 'base64'));
  });
  r.delete('/reps/:id/files/:fileId', async (req, res) => {
    await removeRepFile(repo, String(req.params.id), String(req.params.fileId), actor(req));
    res.json({ files: await filesOf(String(req.params.id)) });
  });
  return r;
}
