/**
 * Small, dependency-free hardening: security headers, a per-IP rate limit
 * and one structured log line per request. Enough for a single-tenant
 * internal tool behind HTTPS; swap in helmet / a store-backed limiter if
 * the deployment grows.
 */
import type { RequestHandler } from 'express';

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // The portal is a Vite bundle served from this origin; fonts come from Google Fonts.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  };
}

/** Sliding-window per-IP limiter. Defaults: 600 requests per minute for the API, 30 per minute for sign-in. */
export function rateLimit(opts: { windowMs: number; max: number; keyPrefix?: string }): RequestHandler {
  const hits = new Map<string, number[]>();
  let sweep = 0;
  return (req, res, next) => {
    const now = Date.now();
    const key = `${opts.keyPrefix ?? ''}${req.ip ?? 'unknown'}`;
    const arr = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (++sweep % 1000 === 0) for (const [k, v] of hits) if (v.every((t) => now - t >= opts.windowMs)) hits.delete(k);
    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - arr.length)));
    if (arr.length > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil(opts.windowMs / 1000)));
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    next();
  };
}

/** One JSON line per request on stderr: method, path, status, duration, actor. Quiet in tests. */
export function requestLog(enabled: boolean): RequestHandler {
  return (req, res, next) => {
    if (!enabled) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const actor = req.session?.user?.repId ?? null;
      console.error(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.originalUrl.split('?')[0], s: res.statusCode, ms: Math.round(ms), actor, ip: req.ip }));
    });
    next();
  };
}
