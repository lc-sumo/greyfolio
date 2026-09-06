/**
 * The owner tier. One email (SUPER_ADMIN_EMAIL, default lc@greystoneus.com)
 * is guaranteed to exist as an active super admin on every boot; from there
 * the owner adds reps and admins and can hand the flag to others. Only a
 * super admin may create or change admins, or change security settings.
 */
import type { Rep } from '@greystone/commission';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';

export const DEFAULT_SUPER_ADMIN_EMAIL = 'lc@greystoneus.com';

export async function ensureSuperAdmin(repo: Repo, email = DEFAULT_SUPER_ADMIN_EMAIL): Promise<{ created: boolean; repId: string }> {
  const e = email.trim().toLowerCase();
  const existing = await repo.findRepByEmail(e);
  if (existing) {
    if (!existing.superAdmin || existing.role !== 'admin' || !existing.active) await repo.updateRep(existing.id, { superAdmin: true, role: 'admin', active: true });
    return { created: false, repId: existing.id };
  }
  const reps = await repo.listReps();
  let id = `rep-${e.split('@')[0]!.replace(/[^a-z0-9]+/g, '-')}`;
  while (reps.some((r) => r.id === id)) id += '-2';
  const rep: Rep = { id, name: 'Leor', email: e, role: 'admin', teamId: null, openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: true, superAdmin: true, perms: null };
  await repo.insertRep(rep);
  await repo.writeAudit({ actorRepId: id, action: 'rep.update', targetRepId: id, path: '/boot/super-admin', detail: { created: true, superAdmin: true, email: e } });
  return { created: true, repId: id };
}

export async function actorOf(repo: Repo, actorRepId: string): Promise<Rep> {
  const a = await repo.findRep(actorRepId);
  if (!a) throw new HttpError(403, 'Unknown actor');
  return a;
}

export function requireSuper(actor: Rep, what: string): void {
  if (!actor.superAdmin) throw new HttpError(403, `Only a super admin can ${what}`);
}
