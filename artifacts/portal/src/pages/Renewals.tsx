import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { AdminDealDrawer } from '../components/AdminDealDrawer';
import { DealDrawer } from '../components/DealDrawer';
import { Shell } from '../components/Shell';
import { Card, Empty, Loading, Pill } from '../components/ui';
import { api, type AdminRenewalRow, type RenewalBucket, type RepRenewalView, type Settings } from '../lib/api';
import { day, money } from '../lib/format';
import { useSession } from '../lib/session';

type Row = RepRenewalView | AdminRenewalRow;
type Tab = 'all' | 'now' | 'prospecting' | 'upcoming' | 'risk' | 'refinanced';

/** CRM wording: "Renewable now" past the mark; "Prospecting" once eligible for more capital; "Upcoming" before either trigger. */
const inTab = (b: RenewalBucket, t: Tab) => t === 'all' || (t === 'now' && b === 'due') || (t === 'prospecting' && b === 'prospecting') || (t === 'upcoming' && b === 'building') || (t === 'risk' && b === 'risk') || (t === 'refinanced' && b === 'refinanced');
const termLabel = (termDays: number | null, frequency: string) => (termDays === null ? '—' : frequency === 'Weekly' ? `${Math.round(termDays / 5)} weeks` : `${termDays} days`);

export function Renewals({ admin }: { admin: boolean }) {
  const { viewAs } = useSession();
  const q = useQuery({ queryKey: [admin ? 'admin-renewals' : 'my-renewals', viewAs], queryFn: () => api<{ renewals: Row[] }>(admin ? '/api/admin/renewals' : '/api/me/renewals') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings'), enabled: admin });
  const mark = settings.data?.thresholds.renewalMark ?? 0.4;
  const capitalDays = settings.data?.thresholds.additionalCapitalAfterDays ?? 30;
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rows = q.data?.renewals ?? [];
  const n = (t: Tab) => rows.filter((r) => inTab(r.bucket, t)).length;
  const withDates = rows.filter((r) => r.markDate).length;
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => inTab(r.bucket, tab) && (!s || `${r.id} ${r.business} ${r.merchantContact} ${r.merchantEmail} ${r.merchantPhone} ${r.lender}`.toLowerCase().includes(s)));
  }, [rows, tab, search]);
  const commissionOf = (r: Row) => ('estRenewalShare' in r ? r.estRenewalShare : r.estRenewalGross);

  return (
    <Shell eyebrow={admin ? 'Admin' : 'Rep portal'} title={admin ? 'Renewals' : 'My renewals'}>
      <Card>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <span className="muted">{withDates} with dates · renewable at {Math.round(mark * 100)}% paid in · more capital {capitalDays} days post funding</span>
          <input className="search" placeholder="Search renewals…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 260 }} />
          <div className="seg">
            {([['all', 'All'], ['now', 'Renewable now'], ['prospecting', 'Prospecting'], ['upcoming', 'Upcoming'], ['risk', 'Blocked'], ['refinanced', 'Refinanced']] as Array<[Tab, string]>).map(([k, label]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label} ({n(k)})</button>
            ))}
          </div>
          <span className="count">{admin ? 'closer calls it, else opener' : 'your deals only'}</span>
        </div>
        {!q.data ? <Loading error={q.error} /> : shown.length === 0 ? <Empty>{tab === 'now' ? 'Nothing is renewable right now.' : 'No renewals here.'}</Empty> : (
          <div className="scroller">
            <div className="table renewals" style={{ ['--cols' as string]: 'minmax(220px,1.5fr) minmax(140px,1fr) 150px 90px 130px 150px 110px 130px 110px 120px minmax(0,1fr)', minWidth: 1640 }}>
              <div className="tr th"><div className="td">Business</div><div className="td">Lender</div><div className="td">Funded</div><div className="td">Term</div><div className="td">More capital</div><div className="td">Renewal</div><div className="td">Due</div><div className="td">Paid off</div><div className="td r">Commission</div><div className="td">{admin ? 'Who calls it' : 'My role'}</div><div className="td">Status</div></div>
              {shown.map((r) => {
                const ready = r.bucket === 'due';
                const due = r.daysToMark === null ? '—' : ready || r.daysToMark < 0 ? `ready ${Math.abs(r.daysToMark)}d` : `in ${r.daysToMark}d`;
                return (
                  <div className="tr click" key={r.id} onClick={() => setOpen(r.id)}>
                    <div className="td ellipsis"><b>{r.business}</b>{'crmUrl' in r && r.crmUrl && <a href={r.crmUrl} target="_blank" rel="noopener" className="crm-mini" onClick={(e) => e.stopPropagation()}>↗</a>}<div className="subtle ellipsis" style={{ fontSize: 11 }}>{r.merchantContact || r.id}{r.merchantPhone ? ` · ${r.merchantPhone}` : ''}</div></div>
                    <div className="td ellipsis">{r.lender}</div>
                    <div className="td num">{money(r.funded)}{'factor' in r && r.factor ? <span className="subtle" style={{ fontSize: 11 }}> ×{r.factor}</span> : null}</div>
                    <div className="td">{termLabel(r.termDays, r.frequency)}</div>
                    <div className="td num">{r.bucket === 'refinanced' || r.bucket === 'risk' ? '—' : r.daysToProspecting <= 0 ? <><span className="pos">eligible</span><div className="subtle" style={{ fontSize: 10.5 }}>since {day(r.prospectingDate)}</div></> : <>{day(r.prospectingDate)}<div className="subtle" style={{ fontSize: 10.5 }}>in {r.daysToProspecting}d</div></>}</div>
                    <div className="td num">{day(r.markDate)}<div className="subtle" style={{ fontSize: 10.5 }}>est. {Math.round(mark * 100)}% of term · {Math.round(r.pctPaidIn * 100)}% in</div></div>
                    <div className="td"><Pill tone={ready ? 'teal' : r.soon ? 'amber' : 'grey'}>{due}</Pill></div>
                    <div className="td num">{day(r.maturityDate)}<div className="subtle" style={{ fontSize: 10.5 }}>est. full term</div></div>
                    <div className="td r num pos">{commissionOf(r) ? money(commissionOf(r)) : '—'}</div>
                    <div className="td">{r.whoCalls === 'You' ? <Pill tone="teal">You</Pill> : 'roles' in r ? `${r.whoCalls} calls · you ${r.roles.join('+').toLowerCase()}` : r.whoCalls}</div>
                    <div className="td"><Pill tone={ready ? 'teal' : r.bucket === 'prospecting' ? 'amber' : r.bucket === 'risk' ? 'red' : 'grey'}>{r.bucketLabel}</Pill></div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>
      {open && !admin && <DealDrawer id={open} onClose={() => setOpen(null)} />}
      {open && admin && settings.data && <AdminDealDrawer id={open} settings={settings.data} editOptions={[]} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
