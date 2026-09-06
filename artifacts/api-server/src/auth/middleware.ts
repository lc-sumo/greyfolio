import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Rep } from '@greystone/commission';
import type { Repo } from '../repo.js';
import { HttpError } from '../http-error.js';
import type { RequestScope, SessionUser } from './session.js';

export const VIEW_AS_HEADER = 'x-view-as';

export { HttpError } from '../http-error.js';

export function currentUser(req: Request): SessionUser | null {
  return req.session?.user ?? null;
}

/**
 * Re-check the signed-in rep on every request: a rep deactivated or demoted
 * mid-session loses access at the next call, not when the cookie expires.
 * Role and name in the cookie are refreshed from the roster as they go.
 */
export function refreshSession(repo: Repo): RequestHandler {
  return async (req, _res, next) => {
    const u = currentUser(req);
    if (!u) return next();
    try {
      const rep = await repo.findRep(u.repId);
      if (!rep || !rep.active) {
        req.session = null;
        return next(new HttpError(401, rep ? `${rep.name} is inactive — ask an admin to reactivate the account` : 'Sign in required'));
      }
      // Idle sign-out: no request for `idleMinutes` ends the session; every request refreshes the clock.
      const idle = (await repo.getSettings()).security.idleMinutes;
      const now = Date.now();
      if (idle > 0 && u.seen && now - Date.parse(u.seen) > idle * 60_000) {
        await repo.writeAudit({ actorRepId: u.repId, action: 'session.idle', targetRepId: null, path: null, detail: { idleMinutes: idle } });
        req.session = null;
        return next(new HttpError(401, `Signed out after ${idle >= 60 && idle % 60 === 0 ? `${idle / 60} hour${idle === 60 ? '' : 's'}` : `${idle} minutes`} of inactivity — sign in again`));
      }
      if (!u.seen || now - Date.parse(u.seen) > 60_000) req.session = { ...req.session, user: { ...u, seen: new Date(now).toISOString() } };
      // A password change (by the rep, an admin, or a reset link) signs every other device out.
      const cutoff = await repo.getSessionCutoff(rep.id);
      if (cutoff && (!u.since || u.since < cutoff)) {
        req.session = null;
        return next(new HttpError(401, 'Signed out because the password on this account changed — sign in again'));
      }
      if (rep.role !== u.role || rep.name !== u.name || rep.email !== u.email) req.session = { ...req.session, user: { ...req.session?.user, ...u, repId: rep.id, email: rep.email, name: rep.name, role: rep.role, seen: req.session?.user?.seen ?? u.seen } };
      // Settings › Portal can require two-factor for admins: until enrolled, an admin may only reach the enrolment routes.
      // req.path is relative to the /api mount, so match on the original URL.
      const url = req.originalUrl.split('?')[0] ?? '';
      if (rep.role === 'admin' && !/^\/api\/me\/totp/.test(url) && url !== '/api/me' && !url.startsWith('/api/me/password')) {
        const sec = (await repo.getSettings()).security;
        if (sec.requireTotpForAdmins && !(await repo.getTotp(rep.id)).enabled) return next(new HttpError(403, 'Two-factor sign-in is required for admins — set it up from the sidebar first'));
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!currentUser(req)) return next(new HttpError(401, 'Sign in required'));
  next();
};

export function requireRole(...roles: Rep['role'][]): RequestHandler {
  return (req, _res, next) => {
    const u = currentUser(req);
    if (!u) return next(new HttpError(401, 'Sign in required'));
    if (!roles.includes(u.role)) return next(new HttpError(403, `This requires one of: ${roles.join(', ')}`));
    next();
  };
}

/**
 * Who may render whose portal:
 *  - admin   → anyone (the departed included — a final balance must be settleable)
 *  - manager → themselves or a rep on their own team   // assumption, see docs
 *  - rep     → themselves only
 */
export async function canViewAs(repo: Repo, actor: SessionUser, targetId: string): Promise<{ ok: true; target: Rep } | { ok: false; reason: string }> {
  const target = await repo.findRep(targetId);
  if (!target) return { ok: false, reason: `Unknown rep ${targetId}` };
  if (target.id === actor.repId) return { ok: true, target };
  if (actor.role === 'admin') return { ok: true, target };
  if (actor.role === 'manager') {
    const me = await repo.findRep(actor.repId);
    if (me?.teamId && target.teamId === me.teamId) return { ok: true, target };
    return { ok: false, reason: `${target.name} is not on your team` };
  }
  return { ok: false, reason: 'Reps can only view their own portal' };
}

/**
 * Resolve the effective rep for this request. View-as is a SERVER-SIDE scope:
 * the target's id replaces the actor's for every downstream query, and the
 * request is audit-logged. There is no client-side filtering to fall back on.
 */
export function resolveScope(repo: Repo): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const actor = currentUser(req);
    if (!actor) return next(new HttpError(401, 'Sign in required'));
    const raw = req.get(VIEW_AS_HEADER) ?? (typeof req.query.viewAs === 'string' ? req.query.viewAs : undefined);
    const target = raw?.trim();
    if (!target || target === actor.repId) {
      req.scope = { actor, effectiveRepId: actor.repId, viewAs: false } satisfies RequestScope;
      return next();
    }
    try {
      const check = await canViewAs(repo, actor, target);
      if (!check.ok) return next(new HttpError(403, check.reason));
      await repo.writeAudit({ actorRepId: actor.repId, action: 'view-as', targetRepId: check.target.id, path: req.originalUrl });
      req.scope = { actor, effectiveRepId: check.target.id, viewAs: true };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function scopeOf(req: Request): RequestScope {
  if (!req.scope) throw new HttpError(500, 'resolveScope did not run');
  return req.scope;
}
