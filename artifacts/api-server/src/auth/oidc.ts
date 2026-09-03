import { Router } from 'express';
import * as oidc from 'openid-client';
import type { AppConfig } from '../config.js';
import type { Repo } from '../repo.js';
import { HttpError, currentUser } from './middleware.js';
import { sessionUserFrom } from './session.js';

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
export function authRouter(config: AppConfig, repo: Repo): Router {
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
    res.json({ ok: true, redirect: config.appOrigin });
  });

  r.get('/me', (req, res) => {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Sign in required');
    res.json({ user: u, canViewAs: u.role === 'admin' || u.role === 'manager', oidc: !!config.oidc, devAuth: config.devAuth });
  });

  return r;
}
