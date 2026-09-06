import { useQuery } from '@tanstack/react-query';
import { Shell } from '../components/Shell';
import { Card, Loading, Pill } from '../components/ui';
import { useState } from 'react';
import { api, type RosterRep, type Scorecard } from '../lib/api';
import { compact, money, pct } from '../lib/format';
import { useSession } from '../lib/session';

/** Rep roster, read from repLedger: every rep's earned, paid, held and owed. Team leads see their own team. */
export function Roster() {
  const { setViewAs, auth } = useSession();
  const q = useQuery({ queryKey: ['roster'], queryFn: () => api<{ reps: RosterRep[] }>('/api/admin/reps') });
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const cards = useQuery({ queryKey: ['scorecards', year], queryFn: () => api<{ year: number; rows: Scorecard[] }>(`/api/admin/scorecards?year=${year}`), enabled: auth?.user.role === 'admin' });
  const reps = [...(q.data?.reps ?? [])].sort((a, b) => b.owed - a.owed);
  const totals = reps.reduce((t, r) => ({ earned: t.earned + r.earned, paid: t.paid + r.paid, owed: t.owed + r.owed }), { earned: 0, paid: 0, owed: 0 });
  return (
    <Shell eyebrow="Admin" title="Rep roster">
      {!q.data ? (
        <Loading error={q.error} />
      ) : (
        <>
          <div className="grid-auto">
            <section className="card"><div className="label">Reps</div><div className="metric">{reps.length}</div><div className="sub">{reps.filter((r) => r.active).length} active</div></section>
            <section className="card"><div className="label">Total earned</div><div className="metric">{money(totals.earned)}</div></section>
            <section className="card"><div className="label">Paid out</div><div className="metric pos">{money(totals.paid)}</div></section>
            <section className="card"><div className="label">Owed to reps</div><div className="metric warn">{money(totals.owed)}</div></section>
          </div>
          {auth?.user.role === 'admin' && (
            <Card title="Scorecards" extra={<span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>production, renewals and follow-through · <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ height: 28 }}>{[0, 1, 2].map((k) => { const y = new Date().getUTCFullYear() - k; return <option key={y} value={y}>{y}</option>; })}</select></span>}>
              {!cards.data ? <Loading error={cards.error} /> : (
                <div className="scroller">
                  <div className="table" style={{ ['--cols' as string]: 'minmax(170px,1.2fr) 60px 100px 100px 120px 120px 110px 110px 90px 100px', minWidth: 1180 }}>
                    <div className="tr th"><div className="td">Rep</div><div className="td r">Deals</div><div className="td r">Funded</div><div className="td r">Gross</div><div className="td r">Renewed / eligible</div><div className="td r">Renewal rate</div><div className="td r">Calls won</div><div className="td r">On time</div><div className="td r">Open</div><div className="td r">Days to close</div></div>
                    {cards.data.rows.map((r) => (
                      <div className="tr" key={r.repId}>
                        <div className="td ellipsis"><b>{r.name}</b><div className="subtle" style={{ fontSize: 13 }}>{r.team ?? '—'}</div></div>
                        <div className="td r num">{r.deals}</div>
                        <div className="td r num">{compact(r.funded)}</div>
                        <div className="td r num">{compact(r.gross)}</div>
                        <div className="td r num">{r.renewed} / {r.renewable}</div>
                        <div className={`td r num ${r.renewalRate === null ? 'subtle' : r.renewalRate >= 50 ? 'pos' : r.renewalRate >= 25 ? 'warn' : 'neg'}`}>{r.renewalRate === null ? '—' : `${r.renewalRate}%`}</div>
                        <div className={`td r num ${r.taskWinRate === null ? 'subtle' : ''}`} title={`${r.tasksWon} funded or app submitted of ${r.tasksClosed} closed`}>{r.taskWinRate === null ? '—' : `${r.taskWinRate}%`}</div>
                        <div className={`td r num ${r.onTimeRate === null ? 'subtle' : r.onTimeRate >= 80 ? 'pos' : 'warn'}`}>{r.onTimeRate === null ? '—' : `${r.onTimeRate}%`}</div>
                        <div className={`td r num ${r.overdueTasks ? 'neg' : ''}`}>{r.openTasks}{r.overdueTasks ? ` (${r.overdueTasks} late)` : ''}</div>
                        <div className="td r num subtle">{r.daysToClose === null ? '—' : `${r.daysToClose}d`}</div>
                      </div>
                    ))}
                    {cards.data.rows.length === 0 && <div className="empty">No activity in {year}.</div>}
                  </div>
                </div>
              )}
            </Card>
          )}
          <Card title="Every rep's money" extra="one ledger — the same numbers each rep sees">
            <div className="scroller">
              <div className="table" style={{ ['--cols' as string]: 'minmax(170px,1.2fr) 130px 90px 70px 70px 70px 110px 110px 100px 110px minmax(0,1fr) 90px', minWidth: 1340 }}>
                <div className="tr th">
                  <div className="td">Rep</div><div className="td">Team</div><div className="td">Access</div><div className="td r">Opener</div><div className="td r">Closer</div><div className="td r">Override</div>
                  <div className="td r">Earned</div><div className="td r">Paid</div><div className="td r">Held</div><div className="td r">Owed</div><div className="td">Status</div><div className="td" />
                </div>
                {reps.map((r) => (
                  <div className="tr" key={r.id}>
                    <div className="td ellipsis"><b>{r.name}</b><div className="subtle ellipsis" style={{ fontSize: 13 }}>{r.email}</div></div>
                    <div className="td ellipsis">{r.team ?? '—'}</div>
                    <div className="td">{r.role === 'admin' ? 'Master' : r.role === 'manager' ? 'Team lead' : 'Rep'}</div>
                    <div className="td r num">{pct(r.openerRate)}</div>
                    <div className="td r num">{pct(r.closerRate)}</div>
                    <div className="td r num">{r.overrideRate === null ? '—' : pct(r.overrideRate)}</div>
                    <div className="td r num">{money(r.earned)}</div>
                    <div className="td r num pos">{money(r.paid)}</div>
                    <div className={`td r num ${r.held ? 'neg' : ''}`}>{money(r.held)}</div>
                    <div className={`td r num ${r.owed ? 'warn' : ''}`}>{money(r.owed)}</div>
                    <div className="td"><Pill tone={r.active ? 'teal' : 'grey'}>{r.active ? 'Active' : 'Inactive'}</Pill></div>
                    <div className="td"><button className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => setViewAs(r.id)}>View as</button></div>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </>
      )}
    </Shell>
  );
}
