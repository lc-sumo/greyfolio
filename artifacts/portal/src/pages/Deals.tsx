import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { DealDrawer } from '../components/DealDrawer';
import { Shell } from '../components/Shell';
import { Card, Empty, Loading, Pill, toneFor } from '../components/ui';
import { api, type RepDealView } from '../lib/api';
import { day, money, pct } from '../lib/format';
import { useSession } from '../lib/session';

const COLS = '90px 84px minmax(170px,1.2fr) 130px minmax(150px,1fr) 110px 150px 70px 110px minmax(0,1fr)';

export function Deals() {
  const { viewAs } = useSession();
  const q = useQuery({ queryKey: ['deals', viewAs], queryFn: () => api<{ count: number; deals: RepDealView[] }>('/api/me/deals') });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = q.data?.deals ?? [];
    const s = search.trim().toLowerCase();
    return all.filter((d) => (!s || `${d.id} ${d.business} ${d.lender} ${d.product}`.toLowerCase().includes(s)) && (status === 'all' || d.payoutStatus === status));
  }, [q.data, search, status]);
  const totals = rows.reduce((t, d) => ({ funded: t.funded + d.funded, share: t.share + d.share, paid: t.paid + d.paid }), { funded: 0, share: 0, paid: 0 });

  return (
    <Shell eyebrow="Rep portal" title="My deals">
      <Card>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <input className="search" placeholder="Search deal, business, lender, product" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All payout statuses</option>
            <option value="Owed">Owed</option>
            <option value="Partially paid">Partially paid</option>
            <option value="Paid">Paid</option>
          </select>
          <span className="count">{rows.length} of {q.data?.count ?? 0} deals</span>
        </div>
        {!q.data ? (
          <Loading error={q.error} />
        ) : rows.length === 0 ? (
          <Empty>No deals match.</Empty>
        ) : (
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: COLS }}>
              <div className="tr th">
                <div className="td">Deal</div><div className="td">Date</div><div className="td">Business</div><div className="td">Lender</div><div className="td">Product</div>
                <div className="td r">Funded</div><div className="td">My role</div><div className="td r">Rate</div><div className="td r">My share</div><div className="td">Status</div>
              </div>
              {rows.map((d) => (
                <div className="tr click" key={d.id} onClick={() => setOpen(d.id)}>
                  <div className="td num">{d.id}{d.clawback && <span className="neg" title="Clawback on this deal"> ●</span>}</div>
                  <div className="td num">{day(d.date)}</div>
                  <div className="td ellipsis">{d.business}{d.drawCount > 0 && <span className="subtle"> · {d.drawCount} draw{d.drawCount > 1 ? 's' : ''}</span>}</div>
                  <div className="td ellipsis">{d.lender}</div>
                  <div className="td ellipsis">{d.product}</div>
                  <div className="td r num">{money(d.funded)}</div>
                  <div className="td">{d.roles.map((r) => <Pill key={r} tone={r === 'Override' ? 'amber' : 'teal'}>{r}</Pill>)}</div>
                  <div className="td r num">{[...new Set(d.lines.map((l) => pct(l.rate)))].join('+')}</div>
                  <div className="td r num">{money(d.share)}</div>
                  <div className="td"><Pill tone={toneFor(d.payoutStatus)}>{d.payoutStatus}</Pill></div>
                </div>
              ))}
              <div className="tr total">
                <div className="td" style={{ gridColumn: '1 / 6' }}>{rows.length} deals</div>
                <div className="td r num">{money(totals.funded)}</div>
                <div className="td" /><div className="td" />
                <div className="td r num">{money(totals.share)}</div>
                <div className="td subtle num">{money(totals.paid)} paid</div>
              </div>
            </div>
          </div>
        )}
      </Card>
      {open && <DealDrawer id={open} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
