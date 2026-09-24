/**
 * Email + password sign-in. Passwords are hashed with scrypt (Node's crypto,
 * no native dependency) and stored as `scrypt$N$salt$key`. Verification is
 * constant-time. An admin sets a rep's password in Settings; the rep can
 * change their own from the portal.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 16384;
const KEY_LEN = 64;

export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'A password is required';
  if (pw.length < MIN_PASSWORD_LENGTH) return `Passwords need at least ${MIN_PASSWORD_LENGTH} characters`;
  if (pw.length > 200) return 'That password is too long';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use at least one letter and one number';
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEY_LEN, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !n || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const got = await scrypt(pw, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Small in-memory throttle: after 5 failures a key (email, or email+IP) waits
 * 15 minutes. Resets on success. Entries expire, and the map is capped, so a
 * flood of made-up emails cannot grow it without bound.
 */
const LOCK_MS = 15 * 60_000;
const MAX_TRACKED = 5_000;
const failures = new Map<string, { n: number; until: number; at: number }>();
function prune(now: number): void {
  if (failures.size < MAX_TRACKED) return;
  for (const [k, f] of failures) if (now - f.at > LOCK_MS) failures.delete(k);
  if (failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value!);
}
export function loginLocked(key: string, now = Date.now()): number {
  const f = failures.get(key);
  if (!f || f.n < 5) return 0;
  return f.until > now ? Math.ceil((f.until - now) / 60_000) : 0;
}
export function noteLoginFailure(key: string, now = Date.now()): void {
  prune(now);
  const f = failures.get(key) ?? { n: 0, until: 0, at: now };
  if (now - f.at > LOCK_MS) { f.n = 0; f.until = 0; }
  f.n += 1;
  f.at = now;
  if (f.n >= 5) f.until = now + LOCK_MS;
  failures.set(key, f);
}
export function clearLoginFailures(key: string): void {
  failures.delete(key);
}
/** Failures are counted per email and per email+IP, so one address cannot lock a colleague out from elsewhere. */
export function loginKeys(email: string, ip: string | null | undefined): string[] {
  return ip ? [email, `${email}|${ip}`] : [email];
}

/** A hash to verify against when the email is unknown, so a miss costs the same time as a wrong password. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('not-a-real-password-just-for-timing');
  return dummyHash;
}

/** A readable temporary password an admin can hand to a rep: `Word-Word-1234`. */
export function temporaryPassword(): string {
  const words = ['Harbor', 'Cedar', 'Summit', 'Granite', 'Willow', 'Copper', 'Meadow', 'Falcon', 'Timber', 'Anchor', 'Beacon', 'Ridge'];
  const pick = () => words[randomBytes(1)[0]! % words.length]!;
  return `${pick()}-${pick()}-${1000 + (randomBytes(2).readUInt16BE(0) % 9000)}`;
}
