export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  scope: string;
}

export interface AppConfig {
  port: number;
  baseUrl: string;
  appOrigin: string;
  sessionSecret: string;
  secureCookies: boolean;
  oidc: OidcConfig | null;
  /** Dev-only email login. Hard-refused in production. */
  devAuth: boolean;
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
  if (production && !oidc) throw new Error('OIDC_ISSUER is required in production');
  return {
    port: Number(env.PORT ?? 8080),
    baseUrl,
    appOrigin: env.APP_ORIGIN ?? baseUrl,
    sessionSecret: sessionSecret || 'dev-only-session-secret-not-for-production',
    secureCookies: production,
    oidc,
    devAuth,
  };
}
