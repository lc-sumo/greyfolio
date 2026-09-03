import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AdminDealDrawer } from '../components/AdminDealDrawer';
import { Shell } from '../components/Shell';
import { Card, Loading, Metric } from '../components/ui';
import { api, qs, type Overview as OverviewData, type Settings } from '../lib/api';
import { compact, day, money, monthLabel, periodRange } from '../lib/format';
import { useSession } from '../lib/session';

export function Overview() {
  const { period } = useSession();
  const range = periodRange(period);
  const q = useQuery({ queryKey: ['overview', range.from, range.to], queryFn: () => api<OverviewData>(`/api/admin/overview${qs(range)}`) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  const [open, setOpen] = useState<string | null>(null);
  const o = q.data;
  const max = o ? Math.max(1, ...o.monthly.map((m) => m.funded)) : 1;
  const maxC = o ? Math.max(1, ...o.monthly.map((m) => m.commission)) : 1;
  const maxCb = o ? Math.max(1, ...o.clawbacks.map((c) => c.repTotal)) : 1;

  return (
    <Shell eyebrow="Admin" title="Funding overview" showPeriod>
      {!o ? <Loading error={q.error} /> : (
        <>
          <div className="grid-auto-180">
            <Metric label="Amount funded" value={compact(o.cards.funded)} sub={`${day(o.period.from)} – ${day(o.period.to)}`} />
            <Metric label="Commissions" value={compact(o.cards.commissions)} sub="gross, incl. PSF and origination" />
            <Metric label="Opportunities" value={String(o.cards.opportunities)} sub={`${o.cards.drawLines} draw line${o.cards.drawLines === 1 ? '' : 's'} on them`} />
            <Metric label="Avg deal size" value={compact(o.cards.avgDealSize)} sub="funded ÷ opportunities" />
            <Metric label="Avg factor rate" value={o.cards.avgFactor === null ? '—' : o.cards.avgFactor.toFixed(2)} sub="factor-rate products only" />
            <Metric label="Paid vs owed" value={`${compact(o.cards.paid)} / ${compact(o.cards.owed)}`} tone={o.cards.owed ? 'warn' : undefined} sub="paid this period · owed to reps (lifetime)" />
            <Metric label="Clawback exposure" value={money(o.cards.clawbackExposure)} tone={o.cards.clawbackExposure ? 'neg' : undefined} sub="open, not yet recovered from reps" />
            <Metric label="Renewal pipeline" value={String(o.cards.renewalReady)} tone="pos" sub={`renewable now · ${compact(o.cards.renewalGross)} est. commission`} />
            <Metric label="Expected from lenders · 30 days" value={money(o.cards.expected30)} tone={o.cards.overdueReceipts ? 'neg' : undefined} sub={`${o.cards.expected30Count} receipt${o.cards.expected30Count === 1 ? '' : 's'} due${o.cards.overdueReceipts ? ` · ${money(o.cards.overdueReceipts)} overdue` : ''}`} />
          </div>

          <div className="two">
            <Card title="Funded volume and commission" extra="by funded month">
              <div className="chart" style={{ height: 200, gridTemplateColumns: `repeat(${o.monthly.length}, minmax(0, 1fr))` }}>
                {o.monthly.map((m) => (
                  <div className="col" key={m.month} title={`${monthLabel(m.month)}: funded ${money(m.funded)}, commission ${money(m.commission)}`}>
                    <div className="bar earned" style={{ height: `${(m.funded / max) * 100}%` }} />
                    <div className="bar paid" style={{ height: `${(m.commission / maxC) * 100}%` }} />
                  </div>
                ))}
              </div>
              <div className="chart-x" style={{ gridTemplateColumns: `repeat(${o.monthly.length}, minmax(0, 1fr))` }}>{o.monthly.map((m) => <span key={m.month}>{monthLabel(m.month)}</span>)}</div>
              <div className="legend"><span><i style={{ background: 'var(--teal)' }} />Funded volume</span><span><i style={{ background: 'var(--amber)' }} />Gross commission (own scale)</span></div>
            </Card>
            <Card title="Lender performance" extra="this period">
              <div className="scroller">
                <div className="table" style={{ ['--cols' as string]: 'minmax(140px,1.2fr) 60px 110px 70px 90px', minWidth: 480 }}>
                  <div className="tr th"><div className="td">Lender</div><div className="td r">Deals</div><div className="td r">Funded</div><div className="td r">Avg factor</div><div className="td r">Collected</div></div>
                  {o.lenders.map((l) => (
                    <div className="tr" key={l.lender}>
                      <div className="td ellipsis">{l.lender}</div>
                      <div className="td r num">{l.deals}</div>
                      <div className="td r num">{compact(l.funded)}</div>
                      <div className="td r num">{l.avgFactor === null ? '—' : l.avgFactor.toFixed(2)}</div>
                      <div className={`td r num ${l.collectedPct >= 100 ? 'pos' : l.collectedPct ? 'warn' : 'subtle'}`}>{l.collectedPct}%</div>
                    </div>
                  ))}
                  {o.lenders.length === 0 && <div className="empty">No deals funded in this period.</div>}
                </div>
              </div>
            </Card>
          </div>

          <div className="two">
            <Card title="Renewal pipeline" extra="renewable now, by est. commission">
              {o.renewals.length === 0 ? <div className="muted">Nothing is renewable right now.</div> : (
                <div className="lb">
                  {o.renewals.map((r) => (
                    <div className="row click" key={r.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto', cursor: 'pointer' }} onClick={() => setOpen(r.id)}>
                      <span className="ellipsis"><b>{r.business}</b> <span className="subtle num">{r.crmId ?? r.id}</span><div className="subtle" style={{ fontSize: 13 }}>{r.lender} · {compact(r.funded)} · mark {day(r.markDate)} · {r.whoCalls} calls</div></span>
                      <span className="amt pos">{money(r.estRenewalGross)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title="Clawback exposure" extra="open clawbacks · reps' share still to recover">
              {o.clawbacks.length === 0 ? <div className="muted">No open clawbacks.</div> : (
                <div className="cbars">
                  {o.clawbacks.map((c) => (
                    <div key={c.id} className="cbar click" onClick={() => setOpen(c.dealId)} style={{ cursor: 'pointer' }}>
                      <div className="cbar-head"><span className="ellipsis"><b>{c.business}</b> <span className="subtle num">{c.dealId} · {day(c.date)}</span></span><span className="num neg">{money(c.remaining)}</span></div>
                      <div className="cbar-track"><i style={{ width: `${(c.repTotal / maxCb) * 100}%` }}><b style={{ width: `${c.repTotal ? (c.recovered / c.repTotal) * 100 : 0}%` }} /></i></div>
                      <div className="subtle" style={{ fontSize: 12.5 }}>deal clawback {money(c.amount)} · reps owe {money(c.repTotal)} · recovered {money(c.recovered)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
      {open && settings.data && <AdminDealDrawer id={open} settings={settings.data} editOptions={[]} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
