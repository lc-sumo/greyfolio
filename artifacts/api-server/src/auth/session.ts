import type { Rep } from '@greystone/commission';

/** What the signed session cookie carries. Keep it small — it travels on every request. */
export interface SessionUser {
  repId: string;
  email: string;
  name: string;
  role: Rep['role'];
  /** When this session was issued (ISO). A password change sets a cut-off; sessions issued before it are refused. */
  since?: string;
  /** Last request (ISO), refreshed at most once a minute; the idle sign-out clock. */
  seen?: string;
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
      /** Password checked, authenticator code still owed. Cleared on success or after 5 minutes. */
      pending2fa?: { repId: string; email: string; at: number };
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
  const now = new Date().toISOString();
  return { repId: rep.id, email: rep.email, name: rep.name, role: rep.role, since: now, seen: now };
}
