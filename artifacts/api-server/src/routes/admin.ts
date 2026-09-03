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

  r.get('/audit', requireRole('admin'), async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
    res.json({ entries: await repo.listAudit(limit) });
  });

  return r;
}
