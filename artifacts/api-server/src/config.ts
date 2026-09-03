export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  scope: string;
}

import { mailConfigFromEnv, type MailConfig } from './services/mail.js';

export interface AppConfig {
  port: number;
  baseUrl: string;
  appOrigin: string;
  sessionSecret: string;
  secureCookies: boolean;
  oidc: OidcConfig | null;
  /** Dev-only email login. Hard-refused in production. */
  devAuth: boolean;
  /** Email + password sign-in (on unless AUTH_PASSWORD=off). */
  passwordAuth: boolean;
  /** One JSON log line per request (off in tests). */
  requestLog: boolean;
  /** Built portal directory to serve (SPA fallback). Optional. */
  portalDist: string | null;
  /** Outbound email: forgot-password links, statements, clawback and renewal notices. */
  mail: MailConfig;
  /** Shown in emails and authenticator apps. */
  appName: string;
  /** Daily renewal digest to admins (UTC hour it goes out; -1 = off). */
  digestHourUtc: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === 'production';
  const baseUrl = (env.BASE_URL ?? `http://localhost:${env.PORT ?? 8080}`).replace(/\/$/, '');
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (production && sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters in production');
  const devAuth = env.AUTH_MODE === 'dev';
  if (production && devAuth) throw new Error('AUTH_MODE=dev is not allowed in production');
  const oidc: OidcConfig | null = env.OIDC_ISSUER
    ? {
        issuer: env.OIDC_ISSUER,
        clientId: env.OIDC_CLIENT_ID ?? '',
        clientSecret: env.OIDC_CLIENT_SECRET || null,
        redirectUri: env.OIDC_REDIRECT_URI ?? `${baseUrl}/auth/callback`,
        scope: env.OIDC_SCOPE ?? 'openid email profile',
      }
    : null;
  const passwordAuth = env.AUTH_PASSWORD !== 'off';
  if (production && !oidc && !passwordAuth) throw new Error('Production needs a sign-in method: set OIDC_ISSUER, or leave AUTH_PASSWORD on');
  return {
    port: Number(env.PORT ?? 8080),
    baseUrl,
    appOrigin: env.APP_ORIGIN ?? baseUrl,
    sessionSecret: sessionSecret || 'dev-only-session-secret-not-for-production',
    secureCookies: production,
    oidc,
    devAuth,
    passwordAuth,
    requestLog: env.REQUEST_LOG !== 'off' && env.NODE_ENV !== 'test' && !env.VITEST && !process.env.VITEST,
    portalDist: env.PORTAL_DIST || null,
    mail: mailConfigFromEnv(env, production),
    appName: env.APP_NAME || 'Greystone Commission Portal',
    digestHourUtc: env.RENEWAL_DIGEST_HOUR_UTC === 'off' ? -1 : Number(env.RENEWAL_DIGEST_HOUR_UTC ?? 13),
  };
}
