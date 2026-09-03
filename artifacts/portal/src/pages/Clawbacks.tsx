import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DealDrawer } from '../components/DealDrawer';
import { Shell } from '../components/Shell';
import { Card, Empty, Loading, Metric, Pill, toneFor } from '../components/ui';
import { api, type RepClawbackView } from '../lib/api';
import { day, money } from '../lib/format';
import { useSession } from '../lib/session';

export function Clawbacks() {
  const { viewAs } = useSession();
  const q = useQuery({ queryKey: ['clawbacks', viewAs], queryFn: () => api<{ clawbacks: RepClawbackView[] }>('/api/me/clawbacks') });
  const [open, setOpen] = useState<string | null>(null);
  const rows = q.data?.clawbacks ?? [];
  const openRows = rows.filter((c) => c.status === 'open');
  const held = openRows.reduce((s, c) => s + c.remaining, 0);
  const recovered = rows.reduce((s, c) => s + c.recovered, 0);

  return (
    <Shell eyebrow="Rep portal" title="Clawbacks">
      <div className="grid-auto">
        <Metric label="Open against me" value={money(held)} tone={held ? 'neg' : undefined} sub={`${openRows.length} open clawback${openRows.length === 1 ? '' : 's'} · nets against my next payout`} />
        <Metric label="Recovered" value={money(recovered)} sub="withheld from past payouts" />
        <Metric label="Deals at risk" value={String(rows.length)} sub="deals with a clawback on record" />
      </div>
      <div className="note">Policy: when a lender claws back a deal's commission, you repay your full share of that deal. The remaining balance is withheld from your next payout — once, never twice.</div>
      <Card>
        {!q.data ? (
          <Loading error={q.error} />
        ) : rows.length === 0 ? (
          <Empty>No clawbacks against you.</Empty>
        ) : (
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: '90px 90px minmax(170px,1.2fr) 130px 130px minmax(200px,1.4fr) minmax(0,1fr)', minWidth: 1000 }}>
              <div className="tr th"><div className="td">Deal</div><div className="td">Date</div><div className="td">Business</div><div className="td r">Deal clawback</div><div className="td r">Charged to me</div><div className="td">Reason</div><div className="td">Status</div></div>
              {rows.map((c) => (
                <div className="tr click tint" key={c.id} onClick={() => setOpen(c.dealId)}>
                  <div className="td num">{c.dealId}</div>
                  <div className="td num">{day(c.date)}</div>
                  <div className="td ellipsis">{c.business}</div>
                  <div className="td r num">{money(c.dealClawback)}</div>
                  <div className="td r num neg">{c.status === 'open' ? money(c.remaining) : money(c.recovered)}<div className="subtle" style={{ fontSize: 10.5 }}>{c.status === 'open' ? 'remaining' : 'withheld'}</div></div>
                  <div className="td ellipsis">{c.reason}</div>
                  <div className="td"><Pill tone={toneFor(c.status)}>{c.status === 'open' ? 'Open' : 'Recovered'}</Pill></div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
      {open && <DealDrawer id={open} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
