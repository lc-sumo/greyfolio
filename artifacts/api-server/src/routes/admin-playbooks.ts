import { Router } from 'express';
import { currentUser, requireRole } from '../auth/middleware.js';
import type { Repo } from '../repo.js';
import type { NotifyDeps } from '../services/notify.js';
import { MERGE_FIELD_HELP, TASK_OUTCOMES, TRIGGER_KINDS } from '../services/playbook-rules.js';
import { createPlaybook, createTask, deletePlaybook, dryRun, ensureStarterPlaybooks, logOutcome, runPlaybooks, saveTemplates, taskViews, updatePlaybook } from '../services/playbooks.js';

const today = () => new Date().toISOString().slice(0, 10);

/** Settings › Playbooks: rules, dry runs, the firing log, tasks across reps, merchant templates. Admin only. */
export function adminPlaybooksRouter(repo: Repo, notify: Omit<NotifyDeps, 'repo'>): Router {
  const r = Router();
  r.use(requireRole('admin'));
  const actor = (req: Parameters<Router>[0]) => currentUser(req)!.repId;

  r.get('/playbooks', async (_req, res) => {
    await ensureStarterPlaybooks(repo);
    const [playbooks, firings, tasks] = await Promise.all([repo.listPlaybooks(), repo.listFirings({ limit: 100_000 }), repo.listTasks()]);
    res.json({
      playbooks: playbooks.map((p) => {
        const mine = firings.filter((f) => f.playbookId === p.id);
        const ts = tasks.filter((t) => t.playbookId === p.id);
        return { ...p, firings: mine.length, lastFired: mine.map((f) => f.firedAt).sort().at(-1) ?? null, openTasks: ts.filter((t) => t.status === 'open').length, doneTasks: ts.filter((t) => t.status === 'done').length };
      }),
      triggers: TRIGGER_KINDS,
      outcomes: TASK_OUTCOMES,
      mergeFields: MERGE_FIELD_HELP,
      lastRun: (await repo.getSetting<string>('playbooks.lastRun')) ?? null,
    });
  });
  r.post('/playbooks', async (req, res) => res.status(201).json(await createPlaybook(repo, req.body ?? {}, actor(req))));
  r.post('/playbooks/dry-run', async (req, res) => res.json(await dryRun(repo, req.body?.rule, today(), typeof req.body?.playbookId === 'string' ? req.body.playbookId : undefined)));
  r.post('/playbooks/run', async (req, res) => res.json(await runPlaybooks({ repo, ...notify }, today(), actor(req))));
  r.get('/playbooks/log', async (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) || 200));
    const [firings, playbooks, reps] = await Promise.all([repo.listFirings({ limit }), repo.listPlaybooks(), repo.listReps()]);
    const pb = new Map(playbooks.map((p) => [p.id, p.name]));
    const rep = new Map(reps.map((x) => [x.id, x.name]));
    res.json({ firings: firings.map((f) => ({ ...f, playbookName: pb.get(f.playbookId) ?? f.playbookId, repName: f.repId ? rep.get(f.repId) ?? f.repId : null })) });
  });
  r.patch('/playbooks/:id', async (req, res) => res.json(await updatePlaybook(repo, String(req.params.id), req.body ?? {}, actor(req))));
  r.delete('/playbooks/:id', async (req, res) => {
    await deletePlaybook(repo, String(req.params.id), actor(req));
    res.status(204).end();
  });

  r.get('/tasks', async (req, res) => {
    const status = req.query.status === 'open' || req.query.status === 'done' ? req.query.status : undefined;
    const repId = typeof req.query.rep === 'string' && req.query.rep ? req.query.rep : undefined;
    const dealId = typeof req.query.deal === 'string' && req.query.deal ? req.query.deal : undefined;
    res.json({ tasks: await taskViews(repo, { status, repId, dealId }, today()) });
  });
  r.post('/deals/:id/tasks', async (req, res) => res.status(201).json(await createTask(repo, { dealId: String(req.params.id), ...(req.body ?? {}) }, actor(req), today())));
  r.patch('/tasks/:id', async (req, res) => res.json(await logOutcome(repo, String(req.params.id), req.body ?? {}, actor(req), today(), { asAdmin: true })));

  r.put('/settings/templates', async (req, res) => res.json({ templates: await saveTemplates(repo, req.body ?? {}, actor(req)) }));
  return r;
}
