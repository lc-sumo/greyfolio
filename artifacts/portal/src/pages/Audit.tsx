import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Shell } from '../components/Shell';
import { Card, Empty, Loading, Pill } from '../components/ui';
import { DEMO, api } from '../lib/api';

interface AuditEntry { actorRepId: string; actorName: string; action: string; targetRepId: string | null; targetName: string | null; path: string | null; detail?: Record<string, unknown>; at?: string; ip?: string | null; location?: string | null }
interface AuditPage { entries: AuditEntry[]; hasMore: boolean; actions: string[]; geo?: boolean }

const TONE: Record<string, 'teal' | 'amber' | 'red' | 'grey'> = { 'payroll.pay': 'teal', 'deal.create': 'teal', 'login.failed': 'red', 'session.idle': 'grey', 'rep.device': 'amber', 'rep.password': 'amber', 'password.reset': 'amber', 'rep.totp': 'amber', 'settings.update': 'amber', 'view-as': 'grey', 'mail.sent': 'grey' };

/** Every login, edit, payout, email and password change the API recorded, with the address it came from. Read-only. */
export function Audit() {
  const [pages, setPages] = useState(1);
  const [action, setAction] = useState('');
  const [rep, setRep] = useState('');
  const [search, setSearch] = useState('');
  const params = new URLSearchParams({ limit: String(500 * pages) });
  if (action) params.set('action', action);
  if (rep) params.set('rep', rep);
  const q = useQuery({ queryKey: ['audit', pages, action, rep], queryFn: () => api<AuditPage>(`/api/admin/audit?${params}`) });
  const reps = useQuery({ queryKey: ['roster-reps'], queryFn: () => api<{ reps: Array<{ id: string; name: string; active: boolean }> }>('/api/admin/reps') });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.entries ?? []).filter((e) => !s || `${e.actorName} ${e.targetName ?? ''} ${e.action} ${e.ip ?? ''} ${e.location ?? ''} ${e.path ?? ''} ${JSON.stringify(e.detail ?? {})}`.toLowerCase().includes(s));
  }, [q.data, search]);
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const csv = `/api/admin/audit.csv`;
  return (
    <Shell eyebrow="Admin" title="Audit log">
      <Card title="Everything the portal recorded" extra={<>newest first · logins, edits, payouts, emails, password changes · showing {q.data?.entries.length ?? 0}{q.data?.hasMore ? <> · <button className="linkish" style={{ color: 'var(--teal)', padding: 0 }} onClick={() => setPages((p) => p + 1)}>load 500 more</button></> : ''}{!DEMO && <> · <a href={csv}>download CSV</a></>}</>}>
        <div className="toolbar" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <input className="search" placeholder="Search actor, target, IP, location, path or detail" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 300 }} />
          <select className="filter" value={rep} onChange={(e) => { setRep(e.target.value); setPages(1); }} title="Entries this rep did, or that were done to them">
            <option value="">All reps</option>
            {(reps.data?.reps ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}{r.active ? '' : ' (inactive)'}</option>)}
          </select>
          <select className="filter" value={action} onChange={(e) => { setAction(e.target.value); setPages(1); }}>
            <option value="">All actions</option>
            {(q.data?.actions ?? (action ? [action] : [])).map((a) => <option key={a}>{a}</option>)}
          </select>
          <span className="count">{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</span>
        </div>
        {!q.data ? <Loading error={q.error} /> : rows.length === 0 ? <Empty>Nothing recorded{rep || action ? ' for that filter' : ' yet'}.</Empty> : (
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: '150px 150px minmax(140px,1fr) 140px 130px 210px minmax(180px,1fr) minmax(260px,1.6fr)', minWidth: 1460 }}>
              <div className="tr th"><div className="td">When</div><div className="td">Action</div><div className="td">By</div><div className="td">About</div><div className="td">IP</div><div className="td">Location</div><div className="td">Where</div><div className="td">Detail</div></div>
              {rows.map((e, i) => (
                <div className="tr" key={i}>
                  <div className="td num">{when(e.at)}</div>
                  <div className="td"><Pill tone={TONE[e.action] ?? 'grey'}>{e.action}</Pill></div>
                  <div className="td ellipsis">{e.actorName}</div>
                  <div className="td ellipsis">{e.targetName ?? <span className="subtle">—</span>}</div>
                  <div className="td num subtle" title={e.ip ?? ''}>{e.ip ?? '—'}</div>
                  <div className="td ellipsis" title={e.location ?? ''}>{e.location ?? <span className="subtle">{e.ip ? (q.data?.geo === false ? 'lookup off' : '…') : '—'}</span>}</div>
                  <div className="td num ellipsis subtle" title={e.path ?? ''}>{e.path ?? '—'}</div>
                  <div className="td ellipsis subtle" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }} title={JSON.stringify(e.detail ?? {})}>{e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : '—'}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </Shell>
  );
}
