/**
 * Time-based one-time passwords (RFC 6238) with node:crypto only — no
 * dependency. Secrets are base32 so any authenticator app can take them.
 * Server-only: never import from the portal bundle.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 160-bit secret, the size Google Authenticator and friends expect. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const key = Buffer.from(base32Decode(secret));
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const code = ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpCode(secret: string, at = Date.now(), step = 30): string {
  return hotp(secret, Math.floor(at / 1000 / step));
}

/** Accepts the current code and one step either side, so clock drift of ±30s still works. */
export function verifyTotp(secret: string, code: unknown, at = Date.now(), step = 30, window = 1): boolean {
  const given = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const counter = Math.floor(at / 1000 / step);
  for (let i = -window; i <= window; i++) {
    const want = hotp(secret, counter + i);
    if (want.length === given.length && timingSafeEqual(Buffer.from(want), Buffer.from(given))) return true;
  }
  return false;
}

/** The URI authenticator apps import (also what a QR code would carry). */
export function otpauthUrl(opts: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  return `otpauth://totp/${label}?secret=${opts.secret}&issuer=${encodeURIComponent(opts.issuer)}&algorithm=SHA1&digits=6&period=30`;
}
