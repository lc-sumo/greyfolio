import { useState, type FormEvent } from 'react';
import { api, ApiError, DEMO, post } from '../lib/api';
import { useSession } from '../lib/session';

type Mode = 'signin' | 'totp' | 'forgot' | 'sent';

export function Login({ oidc, devAuth, password: passwordAuth = true }: { oidc: boolean; devAuth: boolean; password?: boolean }) {
  const { refresh } = useSession();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  async function guard(fn: () => Promise<void>, fallback: string) {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function signIn(e: FormEvent) {
    e.preventDefault();
    void guard(async () => {
      // With a password: email + password. Without one in a dev/demo build: the development sign-in.
      if (password || !devAuth) {
        const r = await post<{ ok: boolean; totp?: boolean }>('/auth/password-login', { email, password });
        if (!r.ok && r.totp) {
          setMode('totp');
          setCode('');
          return;
        }
      } else await api(`/auth/dev-login?email=${encodeURIComponent(email)}`);
      await refresh();
    }, 'Sign-in failed');
  }

  function submitCode(e: FormEvent) {
    e.preventDefault();
    void guard(async () => {
      await post('/auth/totp', { code });
      await refresh();
    }, 'That code was not accepted');
  }

  function forgot(e: FormEvent) {
    e.preventDefault();
    void guard(async () => {
      const r = await post<{ ok: boolean; message: string }>('/auth/forgot', { email });
      setInfo(r.message);
      setMode('sent');
    }, 'Could not send a reset link');
  }

  const linkBtn = (label: string, onClick: () => void) => (
    <button type="button" className="linkish" style={{ color: 'var(--teal)', padding: 0, font: 'inherit', fontWeight: 600 }} onClick={onClick}>{label}</button>
  );

  return (
    <div className="login">
      <div className="left">
        <img src="/greystone-wordmark.png" alt="Greystone Merchant Partners" style={{ filter: 'brightness(0) invert(1)' }} />
        <h1>Every deal.<br />Every <em>dollar</em>.<br />No guessing.</h1>
        <div className="steps">
          <div><b>Reconcile</b><span>One ledger for every rep, every segment, every payout.</span></div>
          <div><b>Prepare</b><span>Payroll from the lines you pick, clawbacks netted once.</span></div>
          <div><b>Protect</b><span>Reps see their money. Only their money.</span></div>
        </div>
      </div>
      <div className="right">
        {mode === 'totp' ? (
          <form onSubmit={submitCode}>
            <h2>Enter your code</h2>
            <div className="note">Open your authenticator app and type the 6-digit code for <b>{email}</b>.</div>
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" placeholder="123 456" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <button className="btn primary big" disabled={busy || code.replace(/\s/g, '').length !== 6}>{busy ? 'Checking…' : 'Continue'}</button>
            <div className="subtle" style={{ fontSize: 13 }}>{linkBtn('Start over', () => { setMode('signin'); setCode(''); setErr(''); })} · Lost your phone? Ask your admin to reset two-factor in Settings › Reps.</div>
            {err && <div className="err">{err}</div>}
          </form>
        ) : mode === 'forgot' || mode === 'sent' ? (
          <form onSubmit={forgot}>
            <h2>Reset your password</h2>
            {mode === 'sent' ? (
              <>
                <div className="note">{info}</div>
                <button type="button" className="btn primary big" onClick={() => { setMode('signin'); setErr(''); }}>Back to sign in</button>
              </>
            ) : (
              <>
                <div className="note">Enter the email on your roster entry. If it matches, a one-hour reset link goes to that inbox.</div>
                <input type="email" placeholder="you@greystoneus.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
                <button className="btn primary big" disabled={busy || !email}>{busy ? 'Sending…' : 'Email me a reset link'}</button>
                <div className="subtle" style={{ fontSize: 13 }}>{linkBtn('Back to sign in', () => { setMode('signin'); setErr(''); })}</div>
              </>
            )}
            {err && <div className="err">{err}</div>}
          </form>
        ) : (
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
                    <b>Preview with demo data.</b> Nothing here is real. Sign in as {linkBtn('Leor (admin)', () => setEmail('leor@greystoneus.com'))},{' '}
                    {linkBtn('Noah Levine (rep)', () => setEmail('noah.levine@greystoneus.com'))} or {linkBtn('Raymond Amato (team lead)', () => setEmail('raymond.amato@greystoneus.com'))}.
                  </div>
                ) : devAuth ? (
                  <div className="note">Development sign-in — enter a provisioned email; add the password if one is set.</div>
                ) : null}
                <input type="email" placeholder="you@greystoneus.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus autoComplete="username" />
                {passwordAuth && <input type="password" placeholder={devAuth ? 'Password (optional in dev)' : 'Password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
                <button className="btn primary big" disabled={busy || !email || (!devAuth && !password)}>{busy ? 'Signing in…' : 'Sign in'}</button>
                {passwordAuth && (
                  <div className="subtle" style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span>{linkBtn('Forgot your password?', () => { setMode('forgot'); setErr(''); })}</span>
                    {!DEMO && <span>Admins set first passwords in Settings › Reps.</span>}
                  </div>
                )}
              </>
            )}
            {!oidc && !devAuth && !passwordAuth && <div className="note">No sign-in method is configured. Set OIDC_ISSUER, leave AUTH_PASSWORD on, or use AUTH_MODE=dev locally.</div>}
            {err && <div className="err">{err}</div>}
          </form>
        )}
      </div>
    </div>
  );
}

/** /reset?token=… — landed on from the email link. Works signed out. */
export function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const weak = password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) return setErr('The two passwords do not match');
    setBusy(true);
    setErr('');
    try {
      const r = await post<{ ok: boolean; email: string }>('/auth/reset', { token, password });
      setDone(r.email);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Could not reset the password');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <div className="left">
        <img src="/greystone-wordmark.png" alt="Greystone Merchant Partners" style={{ filter: 'brightness(0) invert(1)' }} />
        <h1>Choose a new<br /><em>password</em>.</h1>
      </div>
      <div className="right">
        <form onSubmit={submit}>
          <h2>{done ? 'Password changed' : 'New password'}</h2>
          {done ? (
            <>
              <div className="note">Your password for <b>{done}</b> is set. Sign in with it now.</div>
              <button type="button" className="btn primary big" onClick={onDone}>Go to sign in</button>
            </>
          ) : (
            <>
              <div className="note">At least 10 characters with a letter and a number. The link works once, for an hour.</div>
              <input type="password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" />
              <input type="password" placeholder="Type it again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
              <button className="btn primary big" disabled={busy || weak || !again}>{busy ? 'Saving…' : 'Set password'}</button>
              <div className="subtle" style={{ fontSize: 13 }}><button type="button" className="linkish" style={{ color: 'var(--teal)', padding: 0, font: 'inherit', fontWeight: 600 }} onClick={onDone}>Back to sign in</button></div>
            </>
          )}
          {err && <div className="err">{err}</div>}
        </form>
      </div>
    </div>
  );
}
