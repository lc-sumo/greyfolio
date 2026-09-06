/**
 * "Remember this device": after a two-factor sign-in the browser gets a
 * long-lived, HttpOnly cookie with a random secret; only its hash is stored.
 * A later password sign-in from the same browser skips the code until the
 * device expires or is forgotten (by the rep, or by an admin two-factor reset).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Repo, TrustedDevice } from '../repo.js';

export const DEVICE_COOKIE = 'gs.device';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** "Chrome · Mac", "Safari · iPhone" — enough to recognise a row in the devices list. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) && !/Chrome/.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

/** Issue a trusted device for `days` and set the cookie. */
export async function rememberDevice(repo: Repo, req: Request, res: Response, repId: string, days: number, secure: boolean, ip: string | null): Promise<TrustedDevice> {
  const secret = randomBytes(32).toString('base64url');
  const now = new Date();
  const d: TrustedDevice = { id: `dev-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`, repId, tokenHash: sha256(secret), label: deviceLabel(req.headers['user-agent']), ip, createdAt: now.toISOString(), lastUsedAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() };
  await repo.insertTrustedDevice(d);
  res.cookie(DEVICE_COOKIE, `${d.id}.${secret}`, { httpOnly: true, sameSite: 'lax', secure, maxAge: days * 86_400_000, path: '/' });
  await repo.writeAudit({ actorRepId: repId, action: 'rep.device', targetRepId: null, path: '/auth/totp', detail: { deviceId: d.id, label: d.label, days, remembered: true } });
  return d;
}

/** The device this browser presents, if it is still trusted for this rep. */
export async function trustedDeviceFor(repo: Repo, req: Request, repId: string): Promise<TrustedDevice | null> {
  const cookie = readCookie(req, DEVICE_COOKIE);
  if (!cookie) return null;
  const dot = cookie.indexOf('.');
  if (dot < 0) return null;
  const d = await repo.findTrustedDevice(sha256(cookie.slice(dot + 1)));
  if (!d || d.id !== cookie.slice(0, dot) || d.repId !== repId) return null;
  if (d.expiresAt < new Date().toISOString()) {
    await repo.deleteTrustedDevice(d.id);
    return null;
  }
  return d;
}

export function forgetDeviceCookie(res: Response, secure: boolean): void {
  res.cookie(DEVICE_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure, maxAge: 0, path: '/' });
}
