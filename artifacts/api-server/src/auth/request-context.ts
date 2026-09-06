/**
 * Per-request metadata (client IP) that audit rows pick up automatically,
 * so no service has to thread `req` through to `repo.writeAudit`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

export interface RequestMeta {
  ip: string | null;
}

const als = new AsyncLocalStorage<RequestMeta>();

export function requestMeta(): RequestMeta | undefined {
  return als.getStore();
}

/** Express: run the rest of the request inside a context carrying the client IP. */
export function requestContext(): RequestHandler {
  return (req, _res, next) => {
    // `trust proxy` is on, so req.ip is the client behind Replit/Render/Caddy, not the proxy.
    const ip = (req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '') || null;
    als.run({ ip }, () => next());
  };
}
