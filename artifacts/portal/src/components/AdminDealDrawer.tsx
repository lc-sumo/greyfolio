import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, post, type AdminDealDetail, type RepOption, type Settings } from '../lib/api';
import { day, fullDay, money, pct } from '../lib/format';
import { useSession } from '../lib/session';
import { Drawer, Loading, Pill, toneFor } from './ui';

export function AdminDealDrawer({ id, settings, editOptions, onClose }: { id: string; settings: Settings; editOptions: RepOption[]; onClose: () => void }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-deal', id], queryFn: () => api<AdminDealDetail>(`/api/admin/deals/${encodeURIComponent(id)}`) });
  const d = q.data;
  const [drawAmount, setDrawAmount] = useState('');
  const [splits, setSplits] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  useEffect(() => {
    if (d) setSplits({ openerId: d.roles[0]?.repId ?? '', openerRate: String((d.roles[0]?.rate ?? 0) * 100), closerId: d.roles[1]?.repId ?? '', closerRate: String((d.roles[1]?.rate ?? 0) * 100), overrideId: d.roles[2]?.repId ?? '', overrideRate: String((d.roles[2]?.rate ?? 0) * 100) });
  }, [d?.id, d?.roles.map((r) => `${r.repId}:${r.rate}`).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(label: string, fn: () => Promise<unknown>) {
    setErr('');
    try {
      await fn();
      await qc.invalidateQueries();
      notify(label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    }
  }
  const collect = (body: Record<string, unknown>, label: string) => run(label, () => post(`/api/admin/deals/${id}/collection`, body));

  return (
    <Drawer
      title={d ? <>{d.id} <span className="muted" style={{ fontWeight: 500 }}>· {d.business}</span>{d.crmUrl && <a className="crm" href={d.crmUrl} target="_blank" rel="noopener">Open in CRM ↗</a>}</> : id}
      sub={d && `${d.lender} · ${d.product} · funded ${fullDay(d.date)} · ${d.merchantContact}${d.merchantEmail ? ` · ${d.merchantEmail}` : ''}${d.merchantPhone ? ` · ${d.merchantPhone}` : ''}`}
      onClose={onClose}
    >
      {!d ? (
        <Loading error={q.error} />
      ) : (
        <>
          <section className="share">
            <div className="label" style={{ color: 'var(--navy-text-3)' }}>Total rep payout</div>
            <div className="big">{money(d.totalRepPayout)}</div>
            <div className="share-stats">
              <div><span>Gross</span><b>{money(d.gross)}</b></div>
              <div><span>Net after referral</span><b>{money(d.net)}</b></div>
              <div><span>House net</span><b style={{ color: 'var(--teal-bright)' }}>{money(d.houseNet)}</b></div>
              <div><span>Outstanding from lender</span><b style={{ color: d.outstanding ? 'var(--amber-bright)' : 'var(--teal-bright)' }}>{money(d.outstanding)}</b></div>
            </div>
          </section>

          <section className="card">
            <h3>Deal terms</h3>
            <dl className="kv">
              <dt>Funded amount</dt><dd>{money(d.funded)}{d.drawCount ? ` (${d.drawCount} draw${d.drawCount > 1 ? 's' : ''})` : ''}</dd>
              {d.creditLine !== null && <><dt>Credit line</dt><dd>{money(d.creditLine)}</dd></>}
              {d.factor !== null && <><dt>Factor rate</dt><dd>{d.factor.toFixed(2)}</dd></>}
              {d.apr !== null && <><dt>APR</dt><dd>{d.apr}%</dd></>}
              {d.termDays !== null && <><dt>Term</dt><dd>{d.termDays} business days · {d.frequency}</dd></>}
              {d.payback !== null && <><dt>Payback</dt><dd>{money(d.payback)}</dd></>}
              <dt>Commission</dt><dd>{pct(d.commRate)}{d.psfPct ? ` + PSF ${pct(d.psfPct)}` : ''}{d.originationFee ? ` + ${money(d.originationFee)} orig.` : ''}</dd>
              <dt>Referral</dt><dd>{d.referralPartner ? `${d.referralPartner} ${pct(d.referralRate)} · ${money(d.referralFee)}` : '—'}</dd>
              <dt>Commission status</dt><dd style={{ fontFamily: 'var(--sans)' }}>
                <select className="mini" value={d.commissionStatus} onChange={(e) => void collect({ segmentKey: 'base', status: e.target.value }, `${d.id} — commission ${e.target.value.toLowerCase()}`)}>
                  {['Waiting for payment', 'Partially Paid', 'YES - Paid In Full'].map((s) => <option key={s}>{s}</option>)}
                </select>
              </dd>
              <dt>Deal status</dt><dd style={{ fontFamily: 'var(--sans)' }}>
                <select className="mini" value={d.dealStatus} onChange={(e) => run(`${d.id} — ${e.target.value}`, () => post(`/api/admin/deals/${id}/status`, { dealStatus: e.target.value }, 'PATCH'))}>
                  {[...settings.lists.dealStatuses, 'Slow Pay'].map((s) => <option key={s}>{s}</option>)}
                </select>
              </dd>
              <dt>Lender paid</dt><dd>{d.lenderPaid ? fullDay(d.lenderPaid) : '—'}</dd>
              <dt>Rep paid</dt><dd>{d.repPaid ? fullDay(d.repPaid) : '—'}</dd>
            </dl>
          </section>

          {d.segments.map((s) => s.schedule && (
            <section className="card" key={s.sk}>
              <h3>Weekly commission schedule{s.sk !== 'base' && <small>{s.label}</small>}</h3>
              <div className="muted" style={{ marginBottom: 10 }}>{d.lender} pays {money(s.gross)} in {s.schedule.weeks} weekly increments of <b className="num">{money(s.schedule.perWeek)}</b>{s.schedule.startDate ? `, starting ${day(s.schedule.startDate)}` : ''}.</div>
              <div className="pips">{Array.from({ length: s.schedule.weeks }, (_, i) => <i key={i} className={i < s.schedule!.received ? 'on' : ''} />)}</div>
              <dl className="kv" style={{ marginTop: 12 }}>
                <dt>Received</dt><dd>{s.schedule.received}/{s.schedule.weeks} wks · {money(s.collected)}</dd>
                <dt>Still to come</dt><dd>{money(s.outstanding)}</dd>
                <dt>Next due</dt><dd>{s.schedule.received >= s.schedule.weeks ? 'Complete' : s.schedule.startDate ? day(addWeeks(s.schedule.startDate, s.schedule.received)) : '—'}</dd>
              </dl>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn primary" disabled={s.schedule.received >= s.schedule.weeks} onClick={() => void collect({ segmentKey: s.sk, recordWeeks: 1 }, `${d.id} — week ${s.schedule!.received + 1} of ${s.schedule!.weeks} received`)}>Record week received</button>
                <button className="btn" disabled={s.schedule.received <= 0} onClick={() => void collect({ segmentKey: s.sk, recordWeeks: -1 }, `${d.id} — last week reversed`)}>Reverse last</button>
              </div>
            </section>
          ))}

          {(d.drawSubsequentPct || d.drawCount > 0) && (
            <section className="card">
              <h3>Draw ledger <small>one opportunity · {d.segments.length} segment{d.segments.length > 1 ? 's' : ''}</small></h3>
              <div className="pl">
                {d.segments.map((s) => (
                  <div className="row draw" key={s.sk}>
                    <span><b>{s.label}</b> <span className="subtle num">{day(s.date)}</span></span>
                    <span className="num">{money(s.amount)}</span>
                    <span className="num subtle">{pct(s.commRate)}</span>
                    <span className="num">{money(s.net)}</span>
                    <button className={`pill ${toneFor(s.lenderPaidLabel === 'Collected' ? 'Paid' : s.status)}`} style={{ cursor: 'pointer' }} onClick={() => void collect({ segmentKey: s.sk, toggle: true }, `${d.id} ${s.sk} — collection updated`)}>{s.lenderPaidLabel}</button>
                  </div>
                ))}
                <div className="row draw total"><span>Total</span><span className="num">{money(d.funded)}</span><span /><span className="num">{money(d.net)}</span><span className="subtle">{money(d.outstanding)} outstanding</span></div>
              </div>
              {d.drawSubsequentPct && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <input className="search" style={{ minWidth: 0, flex: 1 }} placeholder="Draw amount" inputMode="decimal" value={drawAmount} onChange={(e) => setDrawAmount(e.target.value)} />
                  <button className="btn primary" onClick={() => run(`Draw added to ${d.id}`, async () => { await post(`/api/admin/deals/${id}/draws`, { amount: Number(drawAmount.replace(/[^0-9.]/g, '')) }); setDrawAmount(''); })}>Add draw at {pct(d.drawSubsequentPct)}</button>
                </div>
              )}
            </section>
          )}

          <section className="card">
            <h3>Splits <small>editing an existing deal may reference inactive reps</small></h3>
            <div className="form">
              {(['opener', 'closer', 'override'] as const).map((role, i) => (
                <div className="split-row" key={role}>
                  <label className="field"><span className="label">{role === 'override' ? 'Override rep' : role[0]!.toUpperCase() + role.slice(1)}</span>
                    <select value={splits[`${role}Id`] ?? ''} onChange={(e) => setSplits((s) => ({ ...s, [`${role}Id`]: e.target.value }))}>
                      <option value="">— none —</option>
                      {editOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </label>
                  <label className="field"><span className="label">Rate %</span><input inputMode="decimal" value={splits[`${role}Rate`] ?? ''} onChange={(e) => setSplits((s) => ({ ...s, [`${role}Rate`]: e.target.value }))} /></label>
                  <div><span className="label">Earned · paid</span><div className="num" style={{ paddingTop: 8 }}>{money(d.roles[i]!.amount)} <span className="subtle">· {money(d.roles[i]!.paid)}</span></div></div>
                </div>
              ))}
            </div>
            <button className="btn primary" style={{ marginTop: 10 }} onClick={() => run(`${d.id} — splits saved`, () => post(`/api/admin/deals/${id}/splits`, { openerId: splits.openerId || null, openerRate: Number(splits.openerRate), closerId: splits.closerId || null, closerRate: Number(splits.closerRate), overrideId: splits.overrideId || null, overrideRate: Number(splits.overrideRate) }, 'PATCH'))}>Save splits</button>
          </section>

          <section className="card">
            <h3>Payment history</h3>
            {d.payments.length === 0 ? <div className="muted">Nothing paid on this deal yet.</div> : (
              <div className="pl">
                {d.payments.map((p, i) => (
                  <div className="row" key={i}>
                    <span className={p.amount < 0 ? 'neg' : ''}>{p.repName} · {p.role}{p.segmentKey && p.segmentKey !== 'base' ? ` · ${p.segmentKey}` : ''}</span>
                    <span className={`num ${p.amount < 0 ? 'neg' : 'pos'}`}>{money(p.amount)}</span>
                    <span className="subtle num">{day(p.paidAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {d.clawbacks.map((c) => (
            <div className="note" key={c.id} style={{ background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>
              Clawback {day(c.date)}: <b>{money(c.amount)}</b> — {c.reason}. {c.status === 'open' ? 'Open' : 'Recovered'}: {c.slices.map((s) => `${s.name} ${money(s.remaining)} remaining`).join(', ')}.
            </div>
          ))}
          {err && <div className="note" style={{ background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>{err}</div>}
        </>
      )}
    </Drawer>
  );
}

function addWeeks(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}
