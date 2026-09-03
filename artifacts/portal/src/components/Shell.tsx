import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, type MeInfo } from '../lib/api';
import { initials, type Period } from '../lib/format';
import { useSession } from '../lib/session';

const PERIODS: Period[] = ['7d', '30d', 'QTD', 'YTD'];

export function Shell({ eyebrow, title, showPeriod, children }: { eyebrow: string; title: string; showPeriod?: boolean; children: ReactNode }) {
  const { auth, viewAs, setViewAs: setViewAsRaw, period, setPeriod, logout, toast } = useSession();
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
              <div className="nav-group label" style={{ color: 'var(--navy-text-3)' }}>{viewAs ? 'Rep portal (view as)' : 'My portal'}</div>
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
              <NavLink to="/soon/settings"><i className="dot" />Settings</NavLink>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          {canViewAs && (
            <label className="viewas">
              <span className="label">View as</span>
              <select value={viewAs ?? '__admin'} onChange={(e) => setViewAs(e.target.value === '__admin' ? null : e.target.value)}>
                <option value="__admin">{user.role === 'admin' ? 'Admin — master view' : 'My own portal'}</option>
                {(options.data?.options ?? []).filter((o) => o.id !== user.repId || user.role !== 'admin').map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>
          )}
          <div className="who">
            <div className="avatar">{initials(user.name)}</div>
            <div className="ellipsis">
              <b className="ellipsis">{user.name}</b>
              <span>{user.role === 'admin' ? 'Master' : user.role === 'manager' ? 'Team lead' : 'Rep'}</span>
            </div>
          </div>
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
          {viewAs && me.data && (
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
