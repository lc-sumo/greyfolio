import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';

export function Login({ oidc, devAuth }: { oidc: boolean; devAuth: boolean }) {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function devLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api(`/auth/dev-login?email=${encodeURIComponent(email)}`);
      await refresh();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="left">
        <img src="/greystone-wordmark.png" alt="Greystone Merchant Partners" style={{ filter: 'brightness(0) invert(1)' }} />
        <h1>Every deal.<br />Every dollar.<br />No guessing.</h1>
        <div className="steps">
          <div><b>Reconcile</b><span>One ledger for every rep, every segment, every payout.</span></div>
          <div><b>Prepare</b><span>Payroll from the lines you pick, clawbacks netted once.</span></div>
          <div><b>Protect</b><span>Reps see their money. Only their money.</span></div>
        </div>
      </div>
      <div className="right">
        <form onSubmit={devLogin}>
          <h2>Sign in</h2>
          {oidc && (
            <a className="btn primary big" style={{ display: 'grid', placeItems: 'center' }} href={`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>
              Continue with Greystone SSO
            </a>
          )}
          {devAuth && (
            <>
              <div className="note">Development sign-in — enter the email of a provisioned rep. OIDC replaces this in production.</div>
              <input type="email" placeholder="you@greystoneus.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              <button className="btn primary big" disabled={busy || !email}>{busy ? 'Signing in…' : 'Sign in'}</button>
            </>
          )}
          {!oidc && !devAuth && <div className="note">No sign-in method is configured. Set OIDC_ISSUER (or AUTH_MODE=dev locally) on the API server.</div>}
          {err && <div className="err">{err}</div>}
        </form>
      </div>
    </div>
  );
}
