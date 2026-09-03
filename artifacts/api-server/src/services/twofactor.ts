/** Two-factor enrolment. Server-only (node:crypto through totp.ts). */
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';

export interface TotpStatus {
  enabled: boolean;
  /** A secret was issued but no code has been verified yet. */
  pending: boolean;
}

export async function totpStatus(repo: Repo, repId: string): Promise<TotpStatus> {
  const t = await repo.getTotp(repId);
  return { enabled: t.enabled, pending: !!t.secret && !t.enabled };
}

/** Issue a fresh secret. Refused while two-factor is on — turn it off (with a code) first. */
export async function beginTotp(repo: Repo, repId: string, appName: string): Promise<{ secret: string; otpauth: string }> {
  const rep = await repo.findRep(repId);
  if (!rep) throw new HttpError(404, 'Rep not found');
  const current = await repo.getTotp(repId);
  if (current.enabled) throw new HttpError(400, 'Two-factor is already on — turn it off before setting up a new authenticator');
  const secret = generateTotpSecret();
  await repo.setTotp(repId, { secret, enabled: false });
  return { secret, otpauth: otpauthUrl({ issuer: appName, account: rep.email, secret }) };
}

/** The first correct code proves the authenticator holds the secret; only then does sign-in start asking for codes. */
export async function enableTotp(repo: Repo, repId: string, code: unknown): Promise<void> {
  const t = await repo.getTotp(repId);
  if (!t.secret) throw new HttpError(400, 'Set up an authenticator first');
  if (t.enabled) return;
  if (!verifyTotp(t.secret, code)) throw new HttpError(400, 'That code is not right — check the time on your phone and try the next one');
  await repo.setTotp(repId, { secret: t.secret, enabled: true });
  await repo.writeAudit({ actorRepId: repId, action: 'rep.totp', targetRepId: null, path: '/api/me/totp/enable', detail: { enabled: true } });
}

/** Turning it off takes a current code, so a stolen session cannot silently drop the second factor. */
export async function disableTotp(repo: Repo, repId: string, code: unknown): Promise<void> {
  const t = await repo.getTotp(repId);
  if (!t.secret) return;
  if (t.enabled && !verifyTotp(t.secret, code)) throw new HttpError(400, 'Enter a current code from your authenticator to turn two-factor off');
  await repo.setTotp(repId, { secret: null, enabled: false });
  await repo.writeAudit({ actorRepId: repId, action: 'rep.totp', targetRepId: null, path: '/api/me/totp/disable', detail: { enabled: false } });
}

/** Admin escape hatch for a lost phone. Audited against the admin. */
export async function resetTotp(repo: Repo, repId: string, actorRepId: string): Promise<void> {
  const rep = await repo.findRep(repId);
  if (!rep) throw new HttpError(404, 'Rep not found');
  await repo.setTotp(repId, { secret: null, enabled: false });
  await repo.writeAudit({ actorRepId, action: 'rep.totp', targetRepId: repId, path: `/api/admin/reps/${repId}/totp`, detail: { reset: true } });
}
