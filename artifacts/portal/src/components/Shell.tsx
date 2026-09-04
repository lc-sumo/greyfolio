import { PALETTES, applyPalette, applyTheme, readPalette, readTheme, type Palette, type Theme } from '../lib/theme';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, post, type MeInfo, type TotpStatus } from '../lib/api';
import { initials, type Period } from '../lib/format';
import { useSession } from '../lib/session';

const PERIODS: Period[] = ['7d', '30d', 'QTD', 'YTD'];

export function Shell({ eyebrow, title, showPeriod, children }: { eyebrow: string; title: string; showPeriod?: boolean; children: ReactNode }) {
  const { auth, viewAs, setViewAs: setViewAsRaw, period, setPeriod, logout, toast } = useSession();
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [palette, setPalette] = useState<Palette>(() => readPalette());
  const navigate = useNavigate();
  // Changing whose portal is rendered always starts from that portal's home.
  const setViewAs = (id: string | null) => { setViewAsRaw(id); navigate('/'); };
  const user = auth!.user;
  const canViewAs = auth!.canViewAs;
  const options = useQuery({
    queryKey: ['view-as-options'],
    queryFn: () => api<{ options: Array<{ id: string; label: string }> }>('/api/admin/reps/options?purpose=view-as'),
    enabled: canViewAs,
  });
  const me = useQuery({ queryKey: ['me', viewAs], queryFn: () => api<MeInfo>('/api/me') });
  const repMode = user.role === 'rep' || !!viewAs;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/greystone-icon-white.png" alt="" />
          <div>
            <b>Greystone</b>
            <span>Commission portal</span>
          </div>
        </div>
        <nav className="nav">
          {repMode ? (
            <>
              <div className="nav-group label" style={{ color: 'var(--navy-text-3)' }}>{viewAs && viewAs !== user.repId ? 'Rep portal (view as)' : 'My portal'}</div>
              <NavLink to="/"><i className="dot" />My dashboard</NavLink>
              <NavLink to="/deals"><i className="dot" />My deals</NavLink>
              <NavLink to="/renewals"><i className="dot" />Renewals</NavLink>
              <NavLink to="/clawbacks"><i className="dot" />Clawbacks</NavLink>
              <NavLink to="/payments"><i className="dot" />Pay history</NavLink>
            </>
          ) : (
            <>
              <div className="nav-group label" style={{ color: 'var(--navy-text-3)' }}>Admin</div>
              {user.role === 'admin' ? <NavLink to="/"><i className="dot" />Funding overview</NavLink> : <NavLink to="/"><i className="dot" />Rep roster</NavLink>}
              {user.role === 'admin' && <NavLink to="/deals"><i className="dot" />Master deals</NavLink>}
              {user.role === 'admin' && <NavLink to="/merchants"><i className="dot" />Merchants</NavLink>}
              {user.role === 'admin' && <NavLink to="/payroll"><i className="dot" />Run payroll</NavLink>}
              {user.role === 'admin' && <NavLink to="/renewals"><i className="dot" />Renewals</NavLink>}
              {user.role === 'admin' && <NavLink to="/roster"><i className="dot" />Rep roster</NavLink>}
              {user.role === 'admin' && <NavLink to="/settings"><i className="dot" />Settings</NavLink>}
              {user.role === 'admin' && <NavLink to="/audit"><i className="dot" />Audit log</NavLink>}
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          {canViewAs && (
            <label className="viewas">
              <span className="label">View as</span>
              <select value={viewAs ?? '__admin'} onChange={(e) => setViewAs(e.target.value === '__admin' ? null : e.target.value)}>
                <option value="__admin">{user.role === 'admin' ? 'Admin — master view' : 'My own portal'}</option>
                {(options.data?.options ?? []).map((o) => (
                  <option key={o.id} value={o.id}>{o.id === user.repId ? `${o.label} (me)` : o.label}</option>
                ))}
              </select>
            </label>
          )}
          <div className="theme">
            <span className="label" style={{ color: 'var(--navy-text-3)' }}>Appearance</span>
            <div className="seg" role="group" aria-label="Theme">
              {(['light', 'dark', 'auto'] as Theme[]).map((t) => <button key={t} type="button" className={theme === t ? 'on' : ''} onClick={() => { setTheme(t); applyTheme(t); }}>{t === 'auto' ? 'System' : t[0]!.toUpperCase() + t.slice(1)}</button>)}
            </div>
            <div className="palettes" role="group" aria-label="Palette">
              {PALETTES.map((p) => <button key={p.id} type="button" className={palette === p.id ? 'on' : ''} title={p.label} onClick={() => { setPalette(p.id); applyPalette(p.id); }}><span className="sw">{p.swatch.map((c, i) => <i key={i} style={{ background: c }} />)}</span><span>{p.label}</span></button>)}
            </div>
          </div>
          <div className="who">
            <div className="avatar">{initials(user.name)}</div>
            <div className="ellipsis">
              <b className="ellipsis">{user.name}</b>
              <span>{user.role === 'admin' ? 'Master' : user.role === 'manager' ? 'Team lead' : 'Rep'}</span>
            </div>
          </div>
          {(!viewAs || viewAs === user.repId) && <ChangePassword />}
          {(!viewAs || viewAs === user.repId) && <TwoFactor />}
          <button className="linkish" onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="header">
          <div>
            <div className="label">{eyebrow}</div>
            <h1>{title}</h1>
          </div>
          <div className="right">
            {showPeriod && (
              <div className="seg" role="tablist">
                {PERIODS.map((p) => (
                  <button key={p} className={p === period ? 'on' : ''} onClick={() => setPeriod(p)}>{p}</button>
                ))}
              </div>
            )}
          </div>
        </header>
        <div className="body">
          {viewAs && viewAs !== user.repId && me.data && (
            <div className="banner">
              <span>Viewing as <b>{me.data.rep.name}</b>{!me.data.rep.active && ' (inactive)'} — this is exactly what they see. Every request is audit-logged.</span>
              <button onClick={() => setViewAs(null)}>Exit view-as</button>
            </div>
          )}
          {children}
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** Change my own password from the sidebar. Hidden under View as. */
function TwoFactor() {
  const { notify } = useSession();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['me-totp'], queryFn: () => api<TotpStatus>('/api/me/totp') });
  const [open, setOpen] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = !!status.data?.enabled;
  async function go(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    try { await fn(); await qc.invalidateQueries({ queryKey: ['me-totp'] }); notify(ok); setCode(''); } catch (x) { notify(x instanceof Error ? x.message : 'Something went wrong'); } finally { setBusy(false); }
  }
  if (!open) return <button className="linkish" onClick={() => setOpen(true)}>Two-factor sign-in{enabled ? ' · on' : ''}</button>;
  return (
    <div className="pwform">
      {enabled ? (
        <>
          <div style={{ fontSize: 13, color: 'var(--navy-text-3)' }}>Two-factor is <b style={{ color: '#fff' }}>on</b>. Enter a current code to turn it off.</div>
          <input inputMode="numeric" placeholder="Code from your app" value={code} onChange={(e) => setCode(e.target.value)} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn" style={{ height: 30, padding: '0 10px' }} disabled={busy || code.replace(/\s/g, '').length !== 6} onClick={() => go(() => post('/api/me/totp/disable', { code }).then(() => undefined), 'Two-factor turned off')}>Turn off</button>
            <button type="button" className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => setOpen(false)}>Close</button>
          </div>
        </>
      ) : setup ? (
        <>
          <div style={{ fontSize: 13, color: 'var(--navy-text-3)' }}>In Google Authenticator, 1Password or Authy, add an account with this key, then enter the code it shows.</div>
          <a href={setup.otpauth} style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>Open in authenticator app ↗</a>
          <code style={{ fontSize: 12.5, wordBreak: 'break-all', color: '#fff', background: 'var(--navy-raised)', padding: '6px 8px', borderRadius: 6, userSelect: 'all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          <input inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn primary" style={{ height: 30, padding: '0 10px' }} disabled={busy || code.replace(/\s/g, '').length !== 6} onClick={() => go(() => post('/api/me/totp/enable', { code }).then(() => { setSetup(null); }), 'Two-factor is on — you will be asked for a code at sign-in')}>Verify & turn on</button>
            <button type="button" className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => { setSetup(null); setOpen(false); }}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'var(--navy-text-3)' }}>Add a second step at sign-in: a code from an authenticator app on your phone.</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn primary" style={{ height: 30, padding: '0 10px' }} disabled={busy} onClick={async () => { setBusy(true); try { setSetup(await post('/api/me/totp/setup', {})); } catch (x) { notify(x instanceof Error ? x.message : 'Could not start'); } finally { setBusy(false); } }}>Set up</button>
            <button type="button" className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => setOpen(false)}>Close</button>
          </div>
        </>
      )}
    </div>
  );
}

function ChangePassword() {
  const { notify } = useSession();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <button className="linkish" onClick={() => setOpen(true)}>Change password</button>;
  return (
    <form className="pwform" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await post('/api/me/password', { current, next }); notify('Password changed'); setOpen(false); setCurrent(''); setNext(''); } catch (x) { notify(x instanceof Error ? x.message : 'Could not change password'); } finally { setBusy(false); } }}>
      <input type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      <input type="password" placeholder="New password (10+ chars)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn primary" style={{ height: 30, padding: '0 10px' }} disabled={busy || next.length < 10}>Save</button>
        <button type="button" className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
