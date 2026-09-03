import { useState, type FormEvent } from 'react';
import { api, ApiError, DEMO } from '../lib/api';
import { useSession } from '../lib/session';

export function Login({ oidc, devAuth, password: passwordAuth = true }: { oidc: boolean; devAuth: boolean; password?: boolean }) {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      // With a password: email + password. Without one in a dev/demo build: the development sign-in.
      if (password || !devAuth) await api('/auth/password-login', { method: 'POST', body: JSON.stringify({ email, password }), headers: { 'content-type': 'application/json' } });
      else await api(`/auth/dev-login?email=${encodeURIComponent(email)}`);
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
        <form onSubmit={signIn}>
          <h2>Sign in</h2>
          {oidc && (
            <a className="btn primary big" style={{ display: 'grid', placeItems: 'center' }} href={`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>
              Continue with Greystone SSO
            </a>
          )}
          {(devAuth || passwordAuth) && (
            <>
              {DEMO ? (
                <div className="note">
                  <b>Preview with demo data.</b> Nothing here is real. Sign in as <button type="button" className="linkish" style={{ color: 'var(--teal)', padding: 0, font: 'inherit', fontWeight: 600 }} onClick={() => setEmail('leor@greystoneus.com')}>Leor (admin)</button>,{' '}
                  <button type="button" className="linkish" style={{ color: 'var(--teal)', padding: 0, font: 'inherit', fontWeight: 600 }} onClick={() => setEmail('julian.ribak@greystoneus.com')}>Julian Ribak (rep)</button> or{' '}
                  <button type="button" className="linkish" style={{ color: 'var(--teal)', padding: 0, font: 'inherit', fontWeight: 600 }} onClick={() => setEmail('raymond.amato@greystoneus.com')}>Raymond Amato (team lead)</button>.
                </div>
              ) : devAuth ? (
                <div className="note">Development sign-in — enter a provisioned email; add the password if one is set.</div>
              ) : null}
              <input type="email" placeholder="you@greystoneus.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
              {passwordAuth && <input type="password" placeholder={devAuth ? 'Password (optional in dev)' : 'Password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
              <button className="btn primary big" disabled={busy || !email || (!devAuth && !password)}>{busy ? 'Signing in…' : 'Sign in'}</button>
              {!DEMO && passwordAuth && <div className="subtle" style={{ fontSize: 13 }}>Your admin sets your password in Settings › Reps. You can change it from the portal afterwards.</div>}
            </>
          )}
          {!oidc && !devAuth && !passwordAuth && <div className="note">No sign-in method is configured. Set OIDC_ISSUER, leave AUTH_PASSWORD on, or use AUTH_MODE=dev locally.</div>}
          {err && <div className="err">{err}</div>}
        </form>
      </div>
    </div>
  );
}
