import path from 'node:path';
import cookieSession from 'cookie-session';
import express, { type ErrorRequestHandler } from 'express';
import { authRouter } from './auth/oidc.js';
import { HttpError, refreshSession } from './auth/middleware.js';
import { requestContext } from './auth/request-context.js';
import type { AppConfig } from './config.js';
import type { Repo } from './repo.js';
import { adminRouter } from './routes/admin.js';
import { adminDealsRouter } from './routes/admin-deals.js';
import { adminPayrollRouter } from './routes/admin-payroll.js';
import { adminSettingsRouter } from './routes/admin-settings.js';
import { rateLimit, requestLog, securityHeaders } from './hardening.js';
import { healthRouter } from './routes/health.js';
import { adminBooksRouter } from './routes/admin-books.js';
import { adminPlaybooksRouter } from './routes/admin-playbooks.js';
import { calendarForToken } from './services/calendar.js';
import { createGeo, type Geo } from './services/geo.js';
import { meRouter } from './routes/me.js';
import { mailerFor, type Mailer } from './services/mail.js';

export interface AppDeps {
  /** Override the mailer (tests record instead of sending). */
  mailer?: Mailer;
  /** IP geolocation for the audit log and device list; defaults from config.geo. */
  geo?: Geo;
}

export function createApp(config: AppConfig, repo: Repo, deps: AppDeps = {}): express.Express {
  const app = express();
  const mailer = deps.mailer ?? mailerFor(config.mail);
  const geo = deps.geo ?? createGeo(repo, { lookup: config.geo === 'off' ? null : undefined });
  const notify = { mailer, origin: config.appOrigin, appName: config.appName };
  app.locals.mailer = mailer;
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestContext());
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

  app.use('/', healthRouter(() => repo.getSetting('portal')));
  // Public by token: a rep's calendar feed, subscribed from Google/Apple/Outlook.
  app.get('/calendar/:token.ics', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'cal:' }), async (req, res, next) => {
    try {
      const { ics } = await calendarForToken(repo, String(req.params.token), new Date().toISOString().slice(0, 10), config.appName);
      res.setHeader('content-type', 'text/calendar; charset=utf-8');
      res.setHeader('cache-control', 'private, max-age=300');
      res.send(ics);
    } catch (e) {
      next(e);
    }
  });
  app.use('/auth', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'auth:' }), authRouter(config, repo, mailer));
  app.use('/api', rateLimit({ windowMs: 60_000, max: 600 }), refreshSession(repo));
  app.use('/api/me', meRouter(repo, config.appName, notify, { geo, secureCookies: config.secureCookies }));
  app.use('/api/admin', adminRouter(repo, geo));
  app.use('/api/admin', adminDealsRouter(repo, notify));
  app.use('/api/admin', adminPayrollRouter(repo, notify));
  app.use('/api/admin', adminSettingsRouter(repo, notify));
  app.use('/api/admin', adminBooksRouter(repo));
  app.use('/api/admin', adminPlaybooksRouter(repo, notify));

  if (config.portalDist) {
    const dist = path.resolve(config.portalDist);
    app.use(express.static(dist, { index: 'index.html', maxAge: '1h' }));
    app.get(/^(?!\/(api|auth)\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', path: _req.originalUrl, message, stack: err instanceof Error ? err.stack : undefined }));
    // Admins see what actually failed (usually a database/schema problem); everyone else gets the generic line.
    const admin = _req.session?.user?.role === 'admin';
    res.status(500).json({ error: admin ? `Internal error: ${message}` : 'Internal error' });
  };
  app.use(onError);
  return app;
}
