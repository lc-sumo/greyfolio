import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, post, type TotpStatus, type TrustedDeviceView } from '../lib/api';
import { useSession } from '../lib/session';
import { Card } from './ui';

/** Settings › My account (admins) and the My account page (everyone else): password and two-factor. */
export function AccountPanel() {
  const { auth } = useSession();
  return (
    <div className="grid-auto" style={{ alignItems: 'start' }}>
      <Card title="Password" extra="10+ characters with a letter and a number">
        <ChangePassword />
      </Card>
      <Card title="Two-factor sign-in" extra={auth?.totpRequired ? 'required on this portal' : 'a code from your phone at sign-in'}>
        <TwoFactor required={!!auth?.totpRequired} />
      </Card>
    </div>
  );
}

function ChangePassword() {
  const { notify } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form className="pwform" style={{ margin: 0, maxWidth: 380 }} onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await post('/api/me/password', { current, next }); notify('Password changed — every other device is signed out'); setCurrent(''); setNext(''); } catch (x) { notify(x instanceof Error ? x.message : 'Could not change password'); } finally { setBusy(false); } }}>
      <input type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      <input type="password" placeholder="New password (10+ chars)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      <div><button className="btn primary" disabled={busy || next.length < 10 || !current}>Change password</button></div>
    </form>
  );
}

/** Enrol, see the status, and (only when not required portal-wide) turn it off. `forced` opens straight into setup on the enrolment screen. */
export function TwoFactor({ required = false, forced = false }: { required?: boolean; forced?: boolean }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['me-totp'], queryFn: () => api<TotpStatus>('/api/me/totp') });
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = !!status.data?.enabled;
  async function go(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    try { await fn(); await qc.invalidateQueries({ queryKey: ['me-totp'] }); notify(ok); setCode(''); } catch (x) { notify(x instanceof Error ? x.message : 'Something went wrong'); } finally { setBusy(false); }
  }
  async function begin() {
    setBusy(true);
    try { setSetup(await post('/api/me/totp/setup', {})); } catch (x) { notify(x instanceof Error ? x.message : 'Could not start'); } finally { setBusy(false); }
  }
  if (!status.data) return null;
  if (enabled) {
    return (
      <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
        <div><span className="pill teal">On</span> <span className="muted" style={{ marginLeft: 6 }}>Every sign-in asks for a code from your authenticator app{required ? '. It is required on this portal; if you lose your phone, an admin resets it from Settings › Users.' : '.'}</span></div>
        <Devices />
        {!required && (
          <div className="pwform" style={{ margin: 0, maxWidth: 380 }}>
            <input inputMode="numeric" placeholder="Code from your app" value={code} onChange={(e) => setCode(e.target.value)} />
            <div><button className="btn" disabled={busy || code.replace(/\s/g, '').length !== 6} onClick={() => go(() => post('/api/me/totp/disable', { code }).then(() => undefined), 'Two-factor turned off')}>Turn off</button></div>
          </div>
        )}
      </div>
    );
  }
  if (setup || forced) {
    if (!setup && !busy) void begin();
    return (
      <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
        <div className="muted">In Google Authenticator, 1Password or Authy, add an account with this key, then enter the code it shows.</div>
        {setup && (
          <>
            <a href={setup.otpauth} style={{ fontWeight: 600 }}>Open in authenticator app ↗</a>
            <code style={{ fontSize: 12.5, wordBreak: 'break-all', background: 'var(--sunken)', padding: '6px 8px', borderRadius: 6, userSelect: 'all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            <div className="pwform" style={{ margin: 0, maxWidth: 380 }}>
              <input inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn primary" disabled={busy || code.replace(/\s/g, '').length !== 6} onClick={() => go(() => post('/api/me/totp/enable', { code }).then(() => { setSetup(null); }), 'Two-factor is on — you will be asked for a code at sign-in')}>Verify & turn on</button>
                {!forced && <button type="button" className="btn" onClick={() => setSetup(null)}>Cancel</button>}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 10, maxWidth: 480 }}>
      <div><span className="pill amber">Off</span> <span className="muted" style={{ marginLeft: 6 }}>Add a second step at sign-in: a code from an authenticator app on your phone.</span></div>
      <div><button className="btn primary" disabled={busy} onClick={() => void begin()}>Set up</button></div>
    </div>
  );
}

/** Browsers remembered after a code: where and when, with a forget button. */
function Devices() {
  const { notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me-devices'], queryFn: () => api<{ devices: TrustedDeviceView[] }>('/api/me/devices') });
  const list = q.data?.devices ?? [];
  const ago = (iso: string) => { const d = Math.round((Date.now() - Date.parse(iso)) / 86_400_000); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`; };
  const forget = async (id: string | null) => {
    try { await post(id ? `/api/me/devices/${id}` : '/api/me/devices', {}, 'DELETE'); await qc.invalidateQueries({ queryKey: ['me-devices'] }); notify(id ? 'Device forgotten — it will ask for a code next time' : 'Every device forgotten'); } catch (e) { notify(e instanceof Error ? e.message : 'Could not forget'); }
  };
  return (
    <div className="muted" style={{ fontSize: 12.5, display: 'grid', gap: 4 }}>
      <div style={{ fontWeight: 600 }}>Remembered devices{list.length ? ` · ${list.length}` : ''}</div>
      {list.length === 0 ? <div>None — every sign-in asks for a code.</div> : list.map((d) => (
        <div key={d.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span><b style={{ color: 'var(--ink)', fontWeight: 600 }}>{d.label}</b>{d.current ? ' (this one)' : ''}<div>{d.location ?? d.ip ?? '—'} · used {ago(d.lastUsedAt)} · until {new Date(d.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div></span>
          <button type="button" className="linkish" onClick={() => void forget(d.id)}>forget</button>
        </div>
      ))}
      {list.length > 1 && <button type="button" className="linkish" style={{ justifySelf: 'start' }} onClick={() => void forget(null)}>forget every device</button>}
    </div>
  );
}

/** Two-factor is required: until enrolled, this is the whole app. */
export function EnrollGate() {
  const { auth, logout, refresh } = useSession();
  return (
    <div className="login">
      <div className="left">
        <img src="/greystone-wordmark.png" alt={auth?.branding?.company ?? 'Greystone'} style={{ filter: 'brightness(0) invert(1)' }} />
        <h1>One more<br /><em>step</em>.</h1>
        <div className="steps"><div><b>Two-factor</b><span>This portal requires an authenticator app for every account. Set yours up to continue.</span></div></div>
      </div>
      <div className="right">
        <form onSubmit={(e) => e.preventDefault()} style={{ maxWidth: 480 }}>
          <h2>Set up two-factor sign-in</h2>
          <TwoFactor required forced />
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <button type="button" className="btn primary" onClick={() => void refresh()}>I have turned it on</button>
            <button type="button" className="linkish" onClick={() => void logout()}>Sign out</button>
          </div>
        </form>
      </div>
    </div>
  );
}
