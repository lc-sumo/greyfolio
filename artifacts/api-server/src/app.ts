import path from 'node:path';
import cookieSession from 'cookie-session';
import express, { type ErrorRequestHandler } from 'express';
import { authRouter } from './auth/oidc.js';
import { HttpError } from './auth/middleware.js';
import type { AppConfig } from './config.js';
import type { Repo } from './repo.js';
import { adminRouter } from './routes/admin.js';
import { adminDealsRouter } from './routes/admin-deals.js';
import { adminPayrollRouter } from './routes/admin-payroll.js';
import { adminSettingsRouter } from './routes/admin-settings.js';
import { rateLimit, requestLog, securityHeaders } from './hardening.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';
import { mailerFor, type Mailer } from './services/mail.js';

export interface AppDeps {
  /** Override the mailer (tests record instead of sending). */
  mailer?: Mailer;
}

export function createApp(config: AppConfig, repo: Repo, deps: AppDeps = {}): express.Express {
  const app = express();
  const mailer = deps.mailer ?? mailerFor(config.mail);
  const notify = { mailer, origin: config.appOrigin, appName: config.appName };
  app.locals.mailer = mailer;
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(requestLog(config.requestLog));
  app.use(express.json({ limit: '8mb' })); // a full tracker export is a few MB
  app.use(
    cookieSession({
      name: 'gs.session',
      keys: [config.sessionSecret],
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: 12 * 60 * 60 * 1000,
    }),
  );

  app.use('/', healthRouter());
  app.use('/auth', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'auth:' }), authRouter(config, repo, mailer));
  app.use('/api', rateLimit({ windowMs: 60_000, max: 600 }));
  app.use('/api/me', meRouter(repo, config.appName));
  app.use('/api/admin', adminRouter(repo));
  app.use('/api/admin', adminDealsRouter(repo, notify));
  app.use('/api/admin', adminPayrollRouter(repo, notify));
  app.use('/api/admin', adminSettingsRouter(repo));

  if (config.portalDist) {
    const dist = path.resolve(config.portalDist);
    app.use(express.static(dist, { index: 'index.html', maxAge: '1h' }));
    app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', path: _req.originalUrl, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }));
    res.status(500).json({ error: 'Internal error' });
  };
  app.use(onError);
  return app;
}
