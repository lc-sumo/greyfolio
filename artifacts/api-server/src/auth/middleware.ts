import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Rep } from '@greystone/commission';
import type { Repo } from '../repo.js';
import type { RequestScope, SessionUser } from './session.js';

export const VIEW_AS_HEADER = 'x-view-as';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function currentUser(req: Request): SessionUser | null {
  return req.session?.user ?? null;
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
