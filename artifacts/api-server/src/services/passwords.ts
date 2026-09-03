/** Password writes. Server-only: pulls in node:crypto, so it stays out of the browser demo bundle. */
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';

const audit = (repo: Repo, actorRepId: string, action: 'rep.password', path: string, detail: Record<string, unknown>) =>
  repo.writeAudit({ actorRepId, action, targetRepId: null, path, detail });

/** Admin sets (or clears, with `null`) a rep's sign-in password. The plaintext is never stored or logged. */
export async function setRepPassword(repo: Repo, id: string, password: unknown, actorRepId: string): Promise<{ hasPassword: boolean }> {
  const rep = await repo.findRep(id);
  if (!rep) throw new HttpError(404, 'Rep not found');
  if (password === null) {
    await repo.setPasswordHash(id, null);
    await audit(repo, actorRepId, 'rep.password', `/api/admin/reps/${id}/password`, { cleared: true });
    return { hasPassword: false };
  }
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  await repo.setPasswordHash(id, await hashPassword(password as string));
  await audit(repo, actorRepId, 'rep.password', `/api/admin/reps/${id}/password`, { set: true });
  return { hasPassword: true };
}

/** A rep changes their own password; the current one must match when one is set. */
export async function changeOwnPassword(repo: Repo, repId: string, current: unknown, next: unknown): Promise<void> {
  const existing = await repo.getPasswordHash(repId);
  if (existing && !(await verifyPassword(String(current ?? ''), existing))) throw new HttpError(400, 'Your current password is not right');
  const problem = passwordProblem(next);
  if (problem) throw new HttpError(400, problem);
  await repo.setPasswordHash(repId, await hashPassword(next as string));
  await audit(repo, repId, 'rep.password', '/api/me/password', { self: true });
}
