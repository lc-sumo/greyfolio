import { Router } from 'express';
import * as oidc from 'openid-client';
import type { AppConfig } from '../config.js';
import type { Repo } from '../repo.js';
import { HttpError, currentUser } from './middleware.js';
import { clearLoginFailures, loginLocked, noteLoginFailure, verifyPassword } from './password.js';
import { sessionUserFrom } from './session.js';
import { verifyTotp } from './totp.js';
import type { Mailer } from '../services/mail.js';
import { beginPasswordReset, completePasswordReset, resetThrottled } from '../services/passwords.js';

/** Lazily discovered OIDC configuration (issuer metadata is fetched once). */
export function oidcClient(config: AppConfig) {
  let promise: Promise<oidc.Configuration> | null = null;
  return () => {
    if (!config.oidc) throw new HttpError(503, 'OIDC is not configured');
    const c = config.oidc;
    promise ??= oidc.discovery(new URL(c.issuer), c.clientId, c.clientSecret ?? undefined, c.clientSecret ? undefined : oidc.None());
    return promise;
  };
}

function safeReturnTo(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : undefined;
}

/**
 * Sign-in routes. The prototype's identity picker is replaced by a real
 * authorization-code + PKCE flow; the IdP's email must match a provisioned,
 * active `commission_reps` row or the login is refused.
 */
export function authRouter(config: AppConfig, repo: Repo, mailer: Mailer): Router {
  const r = Router();
  const client = oidcClient(config);

  async function signIn(req: Parameters<Router>[0], email: string): Promise<void> {
    const rep = await repo.findRepByEmail(email);
    if (!rep) throw new HttpError(403, `${email} is not provisioned in the commission portal`);
    if (!rep.active) throw new HttpError(403, `${rep.name} is inactive — ask an admin to reactivate the account`);
    const user = sessionUserFrom(rep);
    req.session = { user };
    await repo.writeAudit({ actorRepId: rep.id, action: 'login', targetRepId: null, path: `${req.baseUrl}${req.path}` });
  }

  r.get('/login', async (req, res) => {
    const c = await client();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    req.session = { ...(req.session ?? {}), oidc: { state, nonce, verifier, returnTo: safeReturnTo(req.query.returnTo) } };
    const url = oidc.buildAuthorizationUrl(c, {
      redirect_uri: config.oidc!.redirectUri,
      scope: config.oidc!.scope,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    res.redirect(url.href);
  });

  r.get('/callback', async (req, res) => {
    const hs = req.session?.oidc;
    if (!hs) throw new HttpError(400, 'No sign-in in progress');
    const c = await client();
    const current = new URL(req.originalUrl, config.baseUrl);
    const tokens = await oidc.authorizationCodeGrant(c, current, { pkceCodeVerifier: hs.verifier, expectedState: hs.state, expectedNonce: hs.nonce });
    const claims = tokens.claims();
    let email = typeof claims?.email === 'string' ? claims.email : undefined;
    if (!email && claims?.sub) {
      const info = await oidc.fetchUserInfo(c, tokens.access_token, claims.sub);
      email = info.email;
    }
    if (!email) throw new HttpError(403, 'The identity provider did not return an email address');
    await signIn(req, email);
    res.redirect(hs.returnTo ? `${config.appOrigin}${hs.returnTo}` : config.appOrigin);
  });

  if (config.devAuth) {
    /** Dev only: `GET /auth/dev-login?email=leor@greystoneus.com`. Refused in production by `configFromEnv`. */
    r.get('/dev-login', async (req, res) => {
      const email = typeof req.query.email === 'string' ? req.query.email : '';
      if (!email) throw new HttpError(400, 'email is required');
      await signIn(req, email);
      res.json({ ok: true, user: req.session?.user });
    });
  }

  /** Email + password. The rep must be provisioned, active, and have a password set by an admin (or themselves). */
  if (config.passwordAuth) {
    r.post('/password-login', async (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const password = String(req.body?.password ?? '');
      if (!email || !password) throw new HttpError(400, 'Email and password are required');
      const wait = loginLocked(email);
      if (wait) throw new HttpError(429, `Too many attempts — try again in ${wait} minute${wait === 1 ? '' : 's'}`);
      const rep = await repo.findRepByEmail(email);
      const ok = rep ? await verifyPassword(password, await repo.getPasswordHash(rep.id)) : false;
      if (!rep || !ok) {
        noteLoginFailure(email);
        await repo.writeAudit({ actorRepId: rep?.id ?? 'unknown', action: 'login.failed', targetRepId: null, path: `${req.baseUrl}${req.path}`, detail: { email } });
        throw new HttpError(401, 'That email and password do not match');
      }
      clearLoginFailures(email);
      const totp = await repo.getTotp(rep.id);
      if (totp.enabled) {
        // Password is right; the authenticator code is still owed. Nothing is signed in yet.
        req.session = { pending2fa: { repId: rep.id, email, at: Date.now() } };
        return res.json({ ok: false, totp: true });
      }
      await signIn(req, email);
      res.json({ ok: true, user: req.session?.user });
    });

    /** Second step for accounts with two-factor on. Five wrong codes lock the email like wrong passwords do. */
    r.post('/totp', async (req, res) => {
      const pending = req.session?.pending2fa;
      if (!pending || Date.now() - pending.at > 5 * 60 * 1000) throw new HttpError(400, 'Start again with your email and password');
      const key = `totp:${pending.email}`;
      const wait = loginLocked(key);
      if (wait) throw new HttpError(429, `Too many attempts — try again in ${wait} minute${wait === 1 ? '' : 's'}`);
      const t = await repo.getTotp(pending.repId);
      if (!t.enabled || !t.secret || !verifyTotp(t.secret, req.body?.code)) {
        noteLoginFailure(key);
        await repo.writeAudit({ actorRepId: pending.repId, action: 'login.failed', targetRepId: null, path: `${req.baseUrl}${req.path}`, detail: { email: pending.email, totp: true } });
        throw new HttpError(401, 'That code is not right');
      }
      clearLoginFailures(key);
      await signIn(req, pending.email);
      res.json({ ok: true, user: req.session?.user });
    });

    /** Forgot password: always answers the same, so the form cannot be used to discover which emails exist. */
    r.post('/forgot', async (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (!email) throw new HttpError(400, 'Email is required');
      if (!mailer.live && mailer.kind !== 'log') throw new HttpError(503, 'Email is not set up on this portal yet — ask your admin to reset your password in Settings › Reps');
      if (!resetThrottled(email)) {
        const started = await beginPasswordReset(repo, email);
        if (started) {
          const link = `${config.appOrigin}/reset?token=${started.token}`;
          const text = [`Hi ${started.name.split(' ')[0]},`, '', 'Someone asked to reset the password on your commission portal account. If that was you, choose a new one here within the hour:', '', link, '', 'If it was not you, ignore this email — nothing changes until the link is used.', '', `— ${config.appName}`].join('\n');
          const sent = await mailer.send({ to: email, subject: `Reset your ${config.appName} password`, text });
          await repo.writeAudit({ actorRepId: started.repId, action: 'mail.sent', targetRepId: null, path: `${req.baseUrl}${req.path}`, detail: { to: email, subject: 'password reset', ok: sent.ok, ...(sent.error ? { error: sent.error } : {}) } });
        }
      }
      res.json({ ok: true, message: 'If that email is on the roster, a reset link is on its way. It works for one hour.' });
    });

    r.post('/reset', async (req, res) => {
      const done = await completePasswordReset(repo, req.body?.token, req.body?.password);
      res.json({ ok: true, email: done.email });
    });
  }

  r.post('/logout', async (req, res) => {
    const u = currentUser(req);
    if (u) await repo.writeAudit({ actorRepId: u.repId, action: 'logout', targetRepId: null, path: `${req.baseUrl}${req.path}` });
    req.session = null;
    if (config.oidc) {
      try {
        const c = await client();
        const url = oidc.buildEndSessionUrl(c, { post_logout_redirect_uri: config.appOrigin });
        return res.json({ ok: true, redirect: url.href });
      } catch {
        /* IdP has no end_session_endpoint — local logout is enough */
      }
    }
    // No IdP session to end: the portal simply re-renders the login screen.
    res.json({ ok: true, redirect: null });
  });

  /** Public: which sign-in methods the login screen should offer. */
  r.get('/methods', (_req, res) => res.json({ oidc: !!config.oidc, devAuth: config.devAuth, password: config.passwordAuth }));

  r.get('/me', (req, res) => {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Sign in required');
    res.json({ user: u, canViewAs: u.role === 'admin' || u.role === 'manager', oidc: !!config.oidc, devAuth: config.devAuth, password: config.passwordAuth });
  });

  return r;
}
