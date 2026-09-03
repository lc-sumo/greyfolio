import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DealDrawer } from '../components/DealDrawer';
import { Shell } from '../components/Shell';
import { Card, Loading, Metric, Pill, toneFor } from '../components/ui';
import { api, qs, type RepDashboard } from '../lib/api';
import { compact, day, fullDay, money, monthLabel, periodRange } from '../lib/format';
import { useSession } from '../lib/session';

export function Dashboard() {
  const { period, viewAs } = useSession();
  const range = periodRange(period);
  const q = useQuery({ queryKey: ['dashboard', range.from, range.to, viewAs], queryFn: () => api<RepDashboard>(`/api/me/dashboard${qs(range)}`) });
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  const max = d ? Math.max(1, ...d.monthly.flatMap((m) => [m.earned, m.paid])) : 1;

  return (
    <Shell eyebrow="Rep portal" title="My dashboard" showPeriod>
      {!d ? (
        <Loading error={q.error} />
      ) : (
        <>
          <section className="wallet">
            <div className="top">
              <div>
                <div className="label">Balance owed to me</div>
                <div className="balance">{money(d.wallet.owed)}</div>
              </div>
              <div className="next">
                <span>Next payout</span>
                <b>{d.nextPayout.date ? fullDay(d.nextPayout.date) : '—'}</b>
                <span>{d.nextPayout.cycle}{d.nextPayout.runLabel ? ` · ${d.nextPayout.runLabel}` : ''}</span>
              </div>
            </div>
            <div className="figs">
              <div><span className="label">Lifetime earned</span><b>{money(d.wallet.earned)}</b></div>
              <div><span className="label">Paid to me</span><b className="teal">{money(d.wallet.paid)}</b></div>
              <div><span className="label">Awaiting lender</span><b className="amber">{money(d.wallet.awaitingLender)}</b></div>
              <div><span className="label">Clawback held</span><b className={d.wallet.held ? 'red' : ''}>{money(d.wallet.held)}</b></div>
            </div>
          </section>

          <div className="grid-auto">
            <Metric label="Earned this period" value={money(d.period.earned)} sub={`${d.period.dealCount} deal${d.period.dealCount === 1 ? '' : 's'} funded ${day(d.period.from)} – ${day(d.period.to)}`} />
            <Metric label="Paid this period" value={money(d.period.paid)} tone="pos" sub={d.period.recovered ? <span className="neg">less {money(d.period.recovered)} clawback recovered</span> : 'no clawbacks recovered'} />
            <Metric label="Balance owed" value={money(d.period.owed)} tone={d.period.owed ? 'warn' : undefined} sub="lifetime · collected from lenders − paid − held" />
            <Metric label="Funded volume" value={compact(d.period.funded)} sub="deals I opened, closed or override" />
            <Metric label="My rank" value={d.period.rank ? `#${d.period.rank}` : '—'} sub={`of ${d.period.repCount} reps by commission this period`} />
          </div>

          <div className="two">
            <Card title="My commission by month" extra="earned by funded month · paid by payout date">
              <div className="chart">
                {d.monthly.map((m) => (
                  <div className="col" key={m.month} title={`${monthLabel(m.month)}: earned ${money(m.earned)}, paid ${money(m.paid)}`}>
                    <div className="bar earned" style={{ height: `${(m.earned / max) * 100}%` }} />
                    <div className="bar paid" style={{ height: `${(m.paid / max) * 100}%` }} />
                  </div>
                ))}
              </div>
              <div className="chart-x">{d.monthly.map((m) => <span key={m.month}>{monthLabel(m.month)}</span>)}</div>
              <div className="legend">
                <span><i style={{ background: 'var(--teal)' }} />Earned — by the month the deal funded</span>
                <span><i style={{ background: 'var(--amber)' }} />Paid — by the month the payout cleared</span>
              </div>
            </Card>
            <Card title="Where I rank" extra="lifetime net commission">
              <div className="lb">
                {d.leaderboard.map((r) => (
                  <div className={`row ${r.isMe ? 'me' : ''}`} key={r.rank}>
                    <span className="rank">#{r.rank}</span>
                    <span className="ellipsis">{r.label}</span>
                    <span className="amt">{compact(r.commission)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card title="Owed to me" extra="most recent unpaid deals">
            {d.owedToMe.length === 0 ? (
              <div className="muted">Nothing outstanding — every line you have earned is paid.</div>
            ) : (
              <div className="scroller">
                <div className="table" style={{ ['--cols' as string]: '90px 90px minmax(170px,1.2fr) 130px 120px 120px minmax(0,1fr)', minWidth: 860 }}>
                  <div className="tr th"><div className="td">Deal</div><div className="td">Date</div><div className="td">Business</div><div className="td">Lender</div><div className="td r">My share</div><div className="td r">Owed</div><div className="td">Lender paid comm</div></div>
                  {d.owedToMe.map((v) => (
                    <div className="tr click" key={v.id} onClick={() => setOpen(v.id)}>
                      <div className="td num">{v.id}</div>
                      <div className="td num">{day(v.date)}</div>
                      <div className="td ellipsis">{v.business}</div>
                      <div className="td ellipsis">{v.lender}</div>
                      <div className="td r num">{money(v.share)}</div>
                      <div className="td r num warn">{money(v.owed)}</div>
                      <div className="td"><Pill tone={toneFor(v.lenderPaidLabel === 'Collected' ? 'Paid' : v.commissionStatus)}>{v.lenderPaidLabel}</Pill></div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </>
      )}
      {open && <DealDrawer id={open} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
