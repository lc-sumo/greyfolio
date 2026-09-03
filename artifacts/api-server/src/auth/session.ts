import type { Rep } from '@greystone/commission';

/** What the signed session cookie carries. Keep it small — it travels on every request. */
export interface SessionUser {
  repId: string;
  email: string;
  name: string;
  role: Rep['role'];
}

export interface OidcHandshake {
  state: string;
  nonce: string;
  verifier: string;
  returnTo?: string;
}

declare global {
  namespace CookieSessionInterfaces {
    interface CookieSessionObject {
      user?: SessionUser;
      oidc?: OidcHandshake;
    }
  }
}

/** The request-level scope every rep-portal handler reads. */
export interface RequestScope {
  actor: SessionUser;
  /** Whose portal is being rendered — the actor, or the View-as target. */
  effectiveRepId: string;
  viewAs: boolean;
}

declare global {
  namespace Express {
    interface Request {
      scope?: RequestScope;
    }
  }
}

export function sessionUserFrom(rep: Rep): SessionUser {
  return { repId: rep.id, email: rep.email, name: rep.name, role: rep.role };
}
