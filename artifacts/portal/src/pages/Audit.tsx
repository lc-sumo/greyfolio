import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { Card, Empty, Loading, Pill } from '../components/ui';
import { DEMO, api } from '../lib/api';

interface AuditEntry { actorRepId: string; action: string; targetRepId: string | null; path: string | null; detail?: Record<string, unknown>; at?: string }

const TONE: Record<string, 'teal' | 'amber' | 'red' | 'grey'> = { 'payroll.pay': 'teal', 'deal.create': 'teal', 'login.failed': 'red', 'rep.password': 'amber', 'settings.update': 'amber', 'view-as': 'grey' };

/** Every login, edit, payout and password change the API recorded. Read-only. */
export function Audit() {
  const [pages, setPages] = useState(1);
  const q = useQuery({ queryKey: ['audit', pages], queryFn: () => api<{ entries: AuditEntry[]; hasMore: boolean }>(`/api/admin/audit?limit=${500 * pages}`) });
  const reps = useQuery({ queryKey: ['roster-reps'], queryFn: () => api<{ reps: Array<{ id: string; name: string }> }>('/api/admin/reps') });
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('all');
  const name = (id: string | null) => (id ? reps.data?.reps.find((r) => r.id === id)?.name ?? id : '—');
  const actions = useMemo(() => [...new Set((q.data?.entries ?? []).map((e) => e.action))].sort(), [q.data]);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.entries ?? []).filter((e) => (action === 'all' || e.action === action) && (!s || `${name(e.actorRepId)} ${name(e.targetRepId)} ${e.action} ${e.path ?? ''} ${JSON.stringify(e.detail ?? {})}`.toLowerCase().includes(s)));
  }, [q.data, search, action, reps.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  return (
    <Shell eyebrow="Admin" title="Audit log">
      <Card title="Everything the portal recorded" extra={<>newest first · logins, edits, payouts, emails, password changes · showing {q.data?.entries.length ?? 0}{q.data?.hasMore ? <> · <button className="linkish" style={{ color: 'var(--teal)', padding: 0 }} onClick={() => setPages((p) => p + 1)}>load 500 more</button></> : ''}{!DEMO && <> · <a href="/api/admin/audit.csv">download CSV</a></>}</>}>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <input className="search" placeholder="Search actor, target, path or detail" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 320 }} />
          <select className="filter" value={action} onChange={(e) => setAction(e.target.value)}><option value="all">All actions</option>{actions.map((a) => <option key={a}>{a}</option>)}</select>
          <span className="count">{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</span>
        </div>
        {!q.data ? <Loading error={q.error} /> : rows.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: '150px 150px minmax(150px,1fr) 150px minmax(220px,1.2fr) minmax(260px,1.6fr)', minWidth: 1100 }}>
              <div className="tr th"><div className="td">When</div><div className="td">Action</div><div className="td">By</div><div className="td">About</div><div className="td">Where</div><div className="td">Detail</div></div>
              {rows.map((e, i) => (
                <div className="tr" key={i}>
                  <div className="td num">{when(e.at)}</div>
                  <div className="td"><Pill tone={TONE[e.action] ?? 'grey'}>{e.action}</Pill></div>
                  <div className="td ellipsis">{name(e.actorRepId)}</div>
                  <div className="td ellipsis">{e.targetRepId ? name(e.targetRepId) : <span className="subtle">—</span>}</div>
                  <div className="td num ellipsis subtle" title={e.path ?? ''}>{e.path ?? '—'}</div>
                  <div className="td ellipsis subtle" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }} title={JSON.stringify(e.detail ?? {})}>{e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : ''}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </Shell>
  );
}
