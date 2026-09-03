import { useQuery } from '@tanstack/react-query';
import { api, type RepDealDetail } from '../lib/api';
import { day, fullDay, money, pct } from '../lib/format';
import { useSession } from '../lib/session';
import { ClawbackBar, Drawer, Loading, Pill, toneFor } from './ui';

export function DealDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { viewAs } = useSession();
  const q = useQuery({ queryKey: ['deal', id, viewAs], queryFn: () => api<RepDealDetail>(`/api/me/deals/${encodeURIComponent(id)}`) });
  const d = q.data;
  return (
    <Drawer title={d ? <>{d.crmId ?? d.id} <span className="muted" style={{ fontWeight: 500 }}>· {d.business}</span></> : id} sub={d && `Sheet ${d.id} · ${d.lender} · ${d.product} · funded ${fullDay(d.date)}`} onClose={onClose}>
      {!d ? (
        <Loading error={q.error} />
      ) : (
        <>
          <div className="share">
            <div className="label" style={{ color: 'var(--navy-text-3)' }}>My share of this deal</div>
            <div className="big">{money(d.share)}</div>
            <div style={{ color: 'var(--navy-text-2)', fontSize: 14.5 }}>
              {d.lines.map((l) => `${l.role} ${pct(l.rate)}${l.segment !== 'Initial' ? ` · ${l.segment}` : ''}`).join(' + ')}
              {' · '}
              <b style={{ color: d.owed ? 'var(--amber-bright)' : 'var(--teal-bright)' }}>{d.owed ? `${money(d.owed)} still owed to me` : d.paid >= d.share ? 'paid in full' : d.paid > 0 ? 'rest awaiting lender payment' : 'awaiting lender payment'}</b>
            </div>
          </div>

          <section className="card">
            <h3>Deal terms</h3>
            <dl className="kv">
              <dt>Funded amount</dt><dd>{money(d.funded)}{d.drawCount ? ` (${d.drawCount} draw${d.drawCount > 1 ? 's' : ''})` : ''}{d.disbursement && <div className="subtle" style={{ fontSize: 12.5, fontFamily: 'var(--sans)' }}>{money(d.disbursement.disbursed)} disbursed · {d.disbursement.count}/{d.disbursement.total} increments{d.disbursement.stopped ? ' · merchant opted out' : ` of ${money(d.disbursement.planned)} planned`}</div>}</dd>
              <dt>Lender</dt><dd className="mono" style={{ fontFamily: 'var(--sans)' }}>{d.lender}</dd>
              <dt>Product</dt><dd style={{ fontFamily: 'var(--sans)' }}>{d.product}</dd>
              <dt>Lender paid commission</dt><dd style={{ fontFamily: 'var(--sans)' }}><Pill tone={toneFor(d.commissionStatus)}>{d.lenderPaidLabel}</Pill></dd>
              <dt>Commission status</dt><dd style={{ fontFamily: 'var(--sans)' }}>{d.commissionStatus}</dd>
              <dt>Deal status</dt><dd style={{ fontFamily: 'var(--sans)' }}>{d.dealStatus}</dd>
              <dt>Clawback</dt><dd style={{ fontFamily: 'var(--sans)' }}>{d.clawbackWindow.cleared ? <span className="cleared"><i>✓</i> {d.clawbackWindow.label}</span> : <Pill tone="amber">{d.clawbackWindow.label}</Pill>}{d.clawbackWindow.clearsOn && <div style={{ display: 'grid', justifyItems: 'end', gap: 4, marginTop: 6 }}><ClawbackBar fundedDate={d.date} win={d.clawbackWindow} />{!d.clawbackWindow.cleared && <div className="subtle" style={{ fontSize: 13 }}>clears {fullDay(d.clawbackWindow.clearsOn)}</div>}</div>}</dd>
              <dt>Rep paid</dt><dd>{d.repPaid ? fullDay(d.repPaid) : '—'}</dd>
            </dl>
          </section>

          <section className="card">
            <h3>My lines <small>one per role per segment</small></h3>
            <div className="pl">
              {d.lines.map((l) => (
                <div className="row" key={`${l.role}|${l.segmentKey}`}>
                  <span>{l.segment} · {l.role} <span className="subtle num">{pct(l.rate)}</span>{l.units && <div className="subtle num" style={{ fontSize: 13 }}>Lender paid {l.units.collected}/{l.units.total} · You paid {l.units.paid}/{l.units.total}</div>}</span>
                  <span className="num">{money(l.amount)}{l.paidAmount > 0 && !l.paid && <div className="subtle" style={{ fontSize: 12.5 }}>{money(l.paidAmount)} paid</div>}</span>
                  <Pill tone={l.paid ? 'teal' : l.paidAmount > 0 ? 'amber' : 'grey'}>{l.paid ? 'Paid' : l.paidAmount > 0 ? 'Partly paid' : 'Owed'}</Pill>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h3>Payment history</h3>
            {d.payments.length === 0 ? (
              <div className="muted">Nothing paid on this deal yet.</div>
            ) : (
              <div className="pl">
                {d.payments.map((p, i) => (
                  <div className="row" key={i}>
                    <span className={p.amount < 0 ? 'neg' : ''}>{p.role}{p.segmentKey && p.segmentKey !== 'base' ? ` · ${p.segmentKey}` : ''}{p.unit ? <span className="subtle"> · {p.unit}</span> : ''}</span>
                    <span className={`num ${p.amount < 0 ? 'neg' : 'pos'}`}>{money(p.amount)}</span>
                    <span className="subtle num">{day(p.paidAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {d.clawback && (
            <div className="note" style={{ background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>
              Clawback on this deal: <b>{money(d.clawback.amount)}</b> charged to you
              {d.clawback.status === 'open' ? <> — <b>{money(d.clawback.remaining)}</b> still nets against your next payout.</> : ' — fully recovered.'}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
