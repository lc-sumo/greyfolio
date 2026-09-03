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
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';

export function createApp(config: AppConfig, repo: Repo): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
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
  app.use('/auth', authRouter(config, repo));
  app.use('/api/me', meRouter(repo));
  app.use('/api/admin', adminRouter(repo));
  app.use('/api/admin', adminDealsRouter(repo));
  app.use('/api/admin', adminPayrollRouter(repo));
  app.use('/api/admin', adminSettingsRouter(repo));

  if (config.portalDist) {
    const dist = path.resolve(config.portalDist);
    app.use(express.static(dist, { index: 'index.html', maxAge: '1h' }));
    app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  };
  app.use(onError);
  return app;
}
