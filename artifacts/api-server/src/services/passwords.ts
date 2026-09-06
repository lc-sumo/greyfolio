/** Password writes. Server-only: pulls in node:crypto, so it stays out of the browser demo bundle. */
import { createHash, randomBytes } from 'node:crypto';
import { clearLoginFailures, hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';
import { actorOf, requireSuper } from './superadmin.js';

const audit = (repo: Repo, actorRepId: string, action: 'rep.password' | 'rep.invite', path: string, detail: Record<string, unknown>, targetRepId: string | null = null) =>
  repo.writeAudit({ actorRepId, action, targetRepId, path, detail });

/** Every password write invalidates sessions issued before now — on every device but the one that made the change (it re-issues). */
const cutOff = async (repo: Repo, repId: string): Promise<string> => {
  const at = new Date().toISOString();
  await repo.setSessionCutoff(repId, at);
  return at;
};

/** Admin sets (or clears, with `null`) a rep's sign-in password. The plaintext is never stored or logged. */
export async function setRepPassword(repo: Repo, id: string, password: unknown, actorRepId: string): Promise<{ hasPassword: boolean }> {
  const rep = await repo.findRep(id);
  if (!rep) throw new HttpError(404, 'Rep not found');
  if (id !== actorRepId && (rep.role === 'admin' || rep.superAdmin)) requireSuper(await actorOf(repo, actorRepId), "set another admin's password");
  if (password === null) {
    await repo.setPasswordHash(id, null);
    if (id !== actorRepId) await cutOff(repo, id);
    await audit(repo, actorRepId, 'rep.password', `/api/admin/reps/${id}/password`, { cleared: true }, id);
    return { hasPassword: false };
  }
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  await repo.setPasswordHash(id, await hashPassword(password as string));
  if (id !== actorRepId) await cutOff(repo, id);
  await audit(repo, actorRepId, 'rep.password', `/api/admin/reps/${id}/password`, { set: true }, id);
  return { hasPassword: true };
}

/** A rep changes their own password; the current one must match when one is set. */
export async function changeOwnPassword(repo: Repo, repId: string, current: unknown, next: unknown): Promise<{ since: string }> {
  const existing = await repo.getPasswordHash(repId);
  if (existing && !(await verifyPassword(String(current ?? ''), existing))) throw new HttpError(400, 'Your current password is not right');
  const problem = passwordProblem(next);
  if (problem) throw new HttpError(400, problem);
  await repo.setPasswordHash(repId, await hashPassword(next as string));
  const at = await cutOff(repo, repId);
  await audit(repo, repId, 'rep.password', '/api/me/password', { self: true });
  // The device that made the change re-issues its session one millisecond after the cut-off.
  return { since: new Date(Date.parse(at) + 1).toISOString() };
}

const RESET_TTL_MS = 60 * 60 * 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Per-email cap on reset emails: 3 an hour, so the form cannot be used to flood an inbox. */
const resetAsks = new Map<string, number[]>();
export function resetThrottled(email: string, now = Date.now()): boolean {
  const recent = (resetAsks.get(email) ?? []).filter((t) => now - t < RESET_TTL_MS);
  resetAsks.set(email, recent);
  if (recent.length >= 3) return true;
  recent.push(now);
  return false;
}

/**
 * Start a "forgot password" reset. Returns the one-time token to put in the
 * email link, or null when there is nothing to send (unknown or inactive
 * email) — the caller answers the same either way so emails cannot be probed.
 */
export async function beginPasswordReset(repo: Repo, email: string): Promise<{ token: string; repId: string; name: string } | null> {
  const rep = await repo.findRepByEmail(email);
  if (!rep || !rep.active) return null;
  const token = randomBytes(32).toString('base64url');
  await repo.createPasswordReset({ id: `pr-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`, repId: rep.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(), usedAt: null });
  await repo.writeAudit({ actorRepId: rep.id, action: 'password.reset', targetRepId: null, path: '/auth/forgot', detail: { requested: true } });
  return { token, repId: rep.id, name: rep.name };
}

/** Finish a reset: the token must be unused and inside its hour; the new password must pass the same rules as everywhere else. */
export async function completePasswordReset(repo: Repo, token: unknown, password: unknown): Promise<{ email: string }> {
  const t = String(token ?? '').trim();
  const reset = t ? await repo.findPasswordReset(sha256(t)) : null;
  if (!reset || reset.usedAt || new Date(reset.expiresAt).getTime() < Date.now()) throw new HttpError(400, 'That reset link is invalid or has expired — ask for a new one');
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  const rep = await repo.findRep(reset.repId);
  if (!rep || !rep.active) throw new HttpError(400, 'That account is no longer active');
  await repo.setPasswordHash(rep.id, await hashPassword(password as string));
  await cutOff(repo, rep.id);
  await repo.consumePasswordReset(reset.id);
  clearLoginFailures(rep.email.toLowerCase());
  await repo.writeAudit({ actorRepId: rep.id, action: 'password.reset', targetRepId: null, path: '/auth/reset', detail: { completed: true } });
  return { email: rep.email };
}

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Admin invites a rep: a 72-hour set-password link goes to the rep's email.
 * Same token table as forgot-password, so `completePasswordReset` finishes it.
 */
export async function beginInvite(repo: Repo, repId: string, actorRepId: string): Promise<{ token: string; rep: { id: string; name: string; email: string } }> {
  const rep = await repo.findRep(repId);
  if (!rep) throw new HttpError(404, 'Rep not found');
  if (!rep.active) throw new HttpError(400, `${rep.name} is inactive — reactivate the account before inviting`);
  const token = randomBytes(32).toString('base64url');
  await repo.createPasswordReset({ id: `inv-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`, repId: rep.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(), usedAt: null });
  await audit(repo, actorRepId, 'rep.invite', `/api/admin/reps/${repId}/invite`, { email: rep.email }, rep.id);
  return { token, rep: { id: rep.id, name: rep.name, email: rep.email } };
}
