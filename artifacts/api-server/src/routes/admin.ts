import { Router } from 'express';
import { repLedger, repOptions } from '@greystone/commission';
import { HttpError, canViewAs, currentUser, requireRole } from '../auth/middleware.js';
import type { Repo } from '../repo.js';
import { resetTotp } from '../services/twofactor.js';

/** Admin surface for Phase 2: roster, rep option lists, View-as targets, audit trail. Phase 4+ adds deals. */
export function adminRouter(repo: Repo): Router {
  const r = Router();

  r.get('/reps', requireRole('admin'), async (_req, res) => {
    const [ctx, reps, teams, withPw, withTotp] = await Promise.all([repo.loadContext(), repo.listReps(), repo.listTeams(), repo.repsWithPassword(), repo.repsWithTotp()]);
    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    const hasPw = new Set(withPw);
    const hasTotp = new Set(withTotp);
    res.json({
      reps: reps.map((rep) => {
        const l = repLedger(ctx, rep.id);
        return {
          id: rep.id,
          name: rep.name,
          email: rep.email,
          role: rep.role,
          teamId: rep.teamId,
          team: rep.teamId ? teamName.get(rep.teamId) ?? null : null,
          openerRate: rep.openerRate,
          closerRate: rep.closerRate,
          overrideRate: rep.overrideRate,
          active: rep.active,
          hasPassword: hasPw.has(rep.id),
          hasTotp: hasTotp.has(rep.id),
          earned: l.earned,
          paid: l.paid,
          held: l.held,
          owed: l.owed,
          dealCount: l.deals.length,
        };
      }),
    });
  });

  /** Lost phone: clear a rep's authenticator so they can sign in with the password alone and enrol again. */
  r.delete('/reps/:id/totp', requireRole('admin'), async (req, res) => {
    await resetTotp(repo, String(req.params.id), currentUser(req)!.repId);
    res.json({ ok: true, hasTotp: false });
  });

  r.get('/teams', requireRole('admin', 'manager'), async (_req, res) => {
    res.json({ teams: await repo.listTeams() });
  });

  /** Invariant #9 — three different option lists. */
  r.get('/reps/options', requireRole('admin', 'manager'), async (req, res) => {
    const purpose = req.query.purpose;
    if (purpose !== 'assign' && purpose !== 'edit' && purpose !== 'view-as') throw new HttpError(400, 'purpose must be assign, edit or view-as');
    const u = currentUser(req)!;
    let reps = await repo.listReps();
    if (purpose === 'view-as' && u.role === 'manager') {
      const me = reps.find((x) => x.id === u.repId);
      reps = reps.filter((x) => x.id === u.repId || (me?.teamId && x.teamId === me.teamId));
    }
    res.json({ options: repOptions(reps, purpose) });
  });

  /** Can the signed-in user open this rep's portal? Same rule the scope middleware enforces. */
  r.get('/view-as/:repId/check', requireRole('admin', 'manager'), async (req, res) => {
    const check = await canViewAs(repo, currentUser(req)!, String(req.params.repId));
    res.json(check.ok ? { ok: true, target: { id: check.target.id, name: check.target.name, active: check.target.active } } : { ok: false, reason: check.reason });
  });

  /** Paged audit trail: `?limit=&offset=&action=&rep=`. */
  const auditQuery = async (req: Parameters<Router>[0]) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : null;
    const rep = typeof req.query.rep === 'string' && req.query.rep ? req.query.rep : null;
    // Filters apply after the page is fetched from storage, so fetch a wider page when filtering.
    const raw = await repo.listAudit(action || rep ? Math.min(5000, limit * 20) : limit, action || rep ? 0 : offset);
    const filtered = raw.filter((e) => (!action || e.action === action) && (!rep || e.actorRepId === rep || e.targetRepId === rep));
    return { entries: action || rep ? filtered.slice(offset, offset + limit) : filtered, limit, offset, hasMore: (action || rep ? filtered.length : raw.length) > offset + limit || (!action && !rep && raw.length === limit) };
  };
  r.get('/audit', requireRole('admin'), async (req, res) => res.json(await auditQuery(req)));
  r.get('/audit.csv', requireRole('admin'), async (req, res) => {
    const [reps, all] = await Promise.all([repo.listReps(), repo.listAudit(5000, 0)]);
    const name = new Map(reps.map((x) => [x.id, x.name]));
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['At', 'Actor', 'Action', 'Target', 'Path', 'Detail'].map(esc).join(',');
    const body = all.map((e) => [e.at ?? '', name.get(e.actorRepId) ?? e.actorRepId, e.action, e.targetRepId ? name.get(e.targetRepId) ?? e.targetRepId : '', e.path ?? '', e.detail ? JSON.stringify(e.detail) : ''].map(esc).join(','));
    res.type('text/csv').attachment('audit-log.csv').send([head, ...body].join('\r\n') + '\r\n');
  });

  return r;
}
