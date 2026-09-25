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
            <b>{auth?.branding?.company?.split(' ')[0] ?? 'Greystone'}</b>
            <span>{auth?.branding?.portal ?? 'Commission portal'}</span>
          </div>
        </div>
        <nav className="nav">
          {repMode ? (
            <>
              <div className="nav-group label" style={{ color: 'var(--navy-text-3)' }}>{viewAs && viewAs !== user.repId ? 'Rep portal (view as)' : 'My portal'}</div>
              <NavLink to="/">My dashboard</NavLink>
              <NavLink to="/deals">My deals</NavLink>
              <NavLink to="/renewals">Renewals</NavLink>
              <NavLink to="/clawbacks">Clawbacks</NavLink>
              <NavLink to="/payments">Pay history</NavLink>
              {(!viewAs || viewAs === user.repId) && <NavLink to="/account">My account</NavLink>}
            </>
          ) : (
            <>
              <div className="nav-group label" style={{ color: 'var(--navy-text-3)' }}>Admin</div>
              {user.role === 'admin' ? <NavLink to="/">Funding overview</NavLink> : <NavLink to="/">Rep roster</NavLink>}
              {user.role === 'admin' && <NavLink to="/deals">Master deals</NavLink>}
              {user.role === 'admin' && <NavLink to="/merchants">Merchants</NavLink>}
              {user.role === 'admin' && <NavLink to="/payroll">Run payroll</NavLink>}
              {user.role === 'admin' && <NavLink to="/renewals">Renewals</NavLink>}
              {user.role === 'admin' && <NavLink to="/books">Books</NavLink>}
              {user.role === 'admin' && <NavLink to="/roster">Rep roster</NavLink>}
              {user.role === 'admin' && <NavLink to="/settings">Settings</NavLink>}
              {user.role === 'admin' && <NavLink to="/audit">Audit log</NavLink>}
              {user.role !== 'admin' && <NavLink to="/account">My account</NavLink>}
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
          <div className="who">
            <div className="avatar">{initials(user.name)}</div>
            <div className="ellipsis">
              <b className="ellipsis">{user.name}</b>
              <span>{auth?.superAdmin ? 'Super admin' : user.role === 'admin' ? 'Master' : user.role === 'manager' ? 'Team lead' : 'Rep'}</span>
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
