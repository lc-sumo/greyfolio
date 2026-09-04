import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DealDrawer } from '../components/DealDrawer';
import { Shell } from '../components/Shell';
import { Card, Loading, Metric } from '../components/ui';
import { api, type PayHistory as PayHistoryData } from '../lib/api';
import { fullDay, moneyCents as money } from '../lib/format';
import { useSession } from '../lib/session';

/** Every payout the rep received: when, how much, and for which deal. Recoveries are shown as their own red lines. */
export function PayHistory() {
  const { viewAs } = useSession();
  const q = useQuery({ queryKey: ['payments', viewAs], queryFn: () => api<PayHistoryData>('/api/me/payments') });
  const [open, setOpen] = useState<string | null>(null);
  const h = q.data;
  return (
    <Shell eyebrow="Rep portal" title="Pay history">
      {!h ? <Loading error={q.error} /> : (
        <>
          <div className="grid-auto">
            <Metric label="Paid to me" value={money(h.summary.grossPaid)} tone="pos" sub="gross across every payout" />
            <Metric label="Clawback recovered" value={money(h.summary.recovered)} tone={h.summary.recovered ? 'neg' : undefined} sub="withheld from those payouts" />
            <Metric label="Cash received" value={money(h.summary.cash)} sub="gross − recovered" />
            <Metric label="Payouts" value={String(h.summary.payouts)} sub="distinct payout dates" />
          </div>
          {h.days.length > 1 && (() => {
            const years = new Map<string, { gross: number; recovered: number; cash: number; payouts: number }>();
            for (const d of h.days) {
              const y = d.date.slice(0, 4);
              const t = years.get(y) ?? { gross: 0, recovered: 0, cash: 0, payouts: 0 };
              years.set(y, { gross: t.gross + d.grossPaid, recovered: t.recovered + d.recovered, cash: t.cash + d.cash, payouts: t.payouts + 1 });
            }
            return (
              <Card title="By year" extra="for your records at tax time">
                <div className="pl">
                  {[...years.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([y, t]) => (
                    <div className="row" key={y}><span>{y}<span className="subtle"> · {t.payouts} payout{t.payouts === 1 ? '' : 's'}</span></span><span className="subtle num">{t.recovered ? `${money(t.gross)} − ${money(t.recovered)}` : ''}</span><span className="num pos">{money(t.cash)}</span></div>
                  ))}
                </div>
              </Card>
            );
          })()}
          {h.days.length === 0 ? <div className="note">No payouts yet — each time payroll pays one of your deal lines it appears here with the date, amount and deal.</div> : h.days.map((d) => (
            <Card key={d.date} title={fullDay(d.date)} extra={d.runLabel ?? undefined}>
              <div className="scroller">
                <div className="table" style={{ ['--cols' as string]: '90px minmax(170px,1.2fr) 170px 110px minmax(0,1fr)', minWidth: 720 }}>
                  <div className="tr th"><div className="td">Deal</div><div className="td">Business</div><div className="td">Line</div><div className="td r">Amount</div><div className="td">Run</div></div>
                  {d.rows.map((r) => (
                    <div className={`tr click ${r.voided ? 'voided' : ''}`} key={r.key} onClick={() => setOpen(r.dealId)}>
                      <div className="td num">{r.dealId}</div>
                      <div className="td ellipsis">{r.business}</div>
                      <div className={`td ${r.role === 'Void' ? 'warn' : r.amount < 0 ? 'neg' : ''}`}>{r.role === 'Void' ? 'Voided payout' : r.amount < 0 ? 'Clawback recovery' : `${r.role} · ${r.segmentLabel}`}{r.voided && <span className="subtle"> · later voided</span>}</div>
                      <div className={`td r num ${r.role === 'Void' ? 'warn' : r.amount < 0 ? 'neg' : 'pos'}`}>{money(r.amount)}</div>
                      <div className="td subtle ellipsis">{r.runLabel ?? '—'}</div>
                    </div>
                  ))}
                  <div className="tr total">
                    <div className="td" style={{ gridColumn: '1 / 4' }}>{d.recovered ? `Gross ${money(d.grossPaid)} − clawback recovered ${money(d.recovered)} = ` : 'Paid '}<span className="num">{money(d.cash)}</span></div>
                    <div className="td r num">{money(d.cash)}</div><div className="td" />
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </>
      )}
      {open && <DealDrawer id={open} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
