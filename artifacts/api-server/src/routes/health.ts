import { Router } from 'express';

/**
 * /health answers 200 while the database answers; 503 otherwise. Point an
 * uptime monitor (UptimeRobot, Better Stack, Replit's own) at it.
 */
export function healthRouter(check?: () => Promise<unknown>): Router {
  const r = Router();
  r.get('/health', async (_req, res) => {
    const at = new Date().toISOString();
    if (!check) return res.json({ ok: true, at });
    try {
      await check();
      res.json({ ok: true, at, db: 'ok' });
    } catch (e) {
      console.error(JSON.stringify({ t: at, level: 'error', health: e instanceof Error ? e.message : String(e) }));
      res.status(503).json({ ok: false, at, db: 'unreachable' });
    }
  });
  return r;
}
