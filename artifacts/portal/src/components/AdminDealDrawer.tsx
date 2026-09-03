import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { DEAL_STATUS_OPTIONS, api, post, type AdminDealDetail, type RepOption, type Settings } from '../lib/api';
import { num } from '../lib/math';
import { parseIncrementGrid, paybackOf, paymentFor } from '@greystone/commission';
import { day, fullDay, money, pct } from '../lib/format';
import { useSession } from '../lib/session';
import { ClawbackBar, Contact, Drawer, Loading, Pill, toneFor } from './ui';

export function AdminDealDrawer({ id, settings, editOptions, onClose }: { id: string; settings: Settings; editOptions: RepOption[]; onClose: () => void }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-deal', id], queryFn: () => api<AdminDealDetail>(`/api/admin/deals/${encodeURIComponent(id)}`) });
  const d = q.data;
  const [drawAmount, setDrawAmount] = useState('');
  const [drawTerm, setDrawTerm] = useState('');
  const [drawFactor, setDrawFactor] = useState('');
  const [crm, setCrm] = useState<string | null>(null);
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
      title={d ? <>{d.crmId ?? d.id} <span className="muted" style={{ fontWeight: 500 }}>· {d.business}</span>{d.crmUrl && <a className="crm" href={d.crmUrl} target="_blank" rel="noopener">Open in CRM ↗</a>}</> : id}
      sub={d && <>{d.lender} · {d.product} · funded {fullDay(d.date)}{(d.merchantContact || d.merchantEmail || d.merchantPhone) && <Contact name={d.merchantContact} email={d.merchantEmail} phone={d.merchantPhone} size="inline" />}</>}
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
              <dt>Deal ID (CRM)</dt><dd style={{ fontFamily: 'var(--sans)' }}>
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <input className="mini-input" placeholder="—" value={crm ?? d.crmId ?? ''} onChange={(e) => setCrm(e.target.value)} />
                  {crm !== null && crm !== (d.crmId ?? '') && <button className="btn" style={{ height: 28, padding: '0 10px' }} onClick={() => run(`${d.id} — CRM deal ID saved`, async () => { await post(`/api/admin/deals/${id}/crm`, { crmId: crm }, 'PATCH'); setCrm(null); })}>Save</button>}
                </span>
              </dd>
              <dt>Sheet #</dt><dd>{d.id}</dd>
              <dt>Funded amount</dt><dd>{money(d.funded)}{d.drawCount ? ` (${d.drawCount} draw${d.drawCount > 1 ? 's' : ''})` : ''}</dd>
              {d.creditLine !== null && <><dt>Credit line</dt><dd>{money(d.creditLine)}</dd></>}
              {d.factor !== null && <><dt>Factor rate</dt><dd>{d.factor.toFixed(2)}</dd></>}
              {d.apr !== null && <><dt>APR</dt><dd>{d.apr}%</dd></>}
              {d.termDays !== null && <><dt>Term</dt><dd>{d.termDays} business days · {d.frequency}</dd></>}
              {d.payback !== null && <><dt>Payback</dt><dd>{money(d.payback)}</dd></>}
              <dt>Clawback</dt><dd style={{ fontFamily: 'var(--sans)' }}><Pill tone={d.clawbackWindow.cleared ? 'teal' : d.atRisk && (d.dealStatus === 'Default' || d.dealStatus === 'Slow Pay') ? 'red' : 'amber'}>{d.clawbackWindow.label}</Pill>{d.clawbackWindow.clearsOn && <div style={{ display: 'grid', justifyItems: 'end', gap: 4, marginTop: 6 }}><ClawbackBar fundedDate={d.date} win={d.clawbackWindow} />{!d.clawbackWindow.cleared && <div className="subtle" style={{ fontSize: 13 }}>clears {fullDay(d.clawbackWindow.clearsOn)} · {d.clawbackWindow.source === 'lender' ? `${d.lender} policy` : 'default window'}</div>}</div>}</dd>
              {d.segments[0]?.payment != null && <><dt>Payment</dt><dd>{money(d.segments[0].payment)} <span className="subtle">/ {d.frequency.toLowerCase()}</span></dd></>}
              <dt>Commission</dt><dd>{pct(d.commRate)}{d.psfPct ? ` + PSF ${pct(d.psfPct)}` : ''}{d.originationFee ? ` + ${money(d.originationFee)} orig.` : ''}</dd>
              <dt>Referral</dt><dd>{d.referralPartner ? `${d.referralPartner} ${pct(d.referralRate)} · ${money(d.referralFee)}` : '—'}</dd>
              <dt>Commission status</dt><dd style={{ fontFamily: 'var(--sans)' }}>
                <select className="mini" value={d.commissionStatus} onChange={(e) => void collect({ segmentKey: 'base', status: e.target.value }, `${d.id} — commission ${e.target.value.toLowerCase()}`)}>
                  {['Waiting for payment', 'Partially Paid', 'YES - Paid In Full'].map((s) => <option key={s}>{s}</option>)}
                </select>
              </dd>
              <dt>Deal status</dt><dd style={{ fontFamily: 'var(--sans)' }}>
                <select className="mini" value={['Performing', 'Prospecting', 'Refi Ready'].includes(d.storedDealStatus) ? 'Performing' : d.storedDealStatus} onChange={(e) => run(`${d.id} — ${e.target.value}`, () => post(`/api/admin/deals/${id}/status`, { dealStatus: e.target.value }, 'PATCH'))}>
                  {DEAL_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.value === 'Performing' ? `Auto · ${d.dealStatus}` : o.label}</option>)}
                </select>
              </dd>
              <dt>Lender paid</dt><dd>{d.lenderPaid ? fullDay(d.lenderPaid) : '—'}</dd>
              <dt>Rep paid</dt><dd>{d.repPaid ? fullDay(d.repPaid) : '—'}</dd>
            </dl>
          </section>

          {d.segments.map((s) => s.schedule && (
            <section className="card" key={s.sk}>
              <h3>Commission payout schedule{s.sk !== 'base' && <small>{s.label}</small>}{s.schedule.overdue > 0 && <small className="neg">{s.schedule.overdue} overdue · {money(s.schedule.overdueAmount)}</small>}</h3>
              <div className="muted" style={{ marginBottom: 10 }}>
                {d.lender} pays {money(s.gross)}:{s.schedule.upfrontPct > 0 && <> <b className="num">{money(s.schedule.upfrontAmount)}</b> upfront ({Math.round(s.schedule.upfrontPct * 100)}%), then</>} {s.schedule.weeks} increments every {s.schedule.cadenceDays === 7 ? 'week' : s.schedule.cadenceDays === 14 ? 'two weeks' : `${s.schedule.cadenceDays} days`}
                {s.schedule.amounts ? <> in the grid's proportions (disbursements step from <b className="num">{money(s.schedule.amounts[0]!)}</b> to <b className="num">{money(s.schedule.amounts[s.schedule.amounts.length - 1]!)}</b>)</> : s.schedule.remainder === 'spread' ? <> of <b className="num">{money(s.schedule.perWeek)}</b></> : <>, and <b className="num">{money(s.schedule.remainderAmount)}</b> once they are done</>}{s.schedule.startDate ? `, starting ${day(s.schedule.startDate)}` : ''}.
              </div>
              <div className="fundprog">
                <div className="head"><span className="label">Funding progress</span><span className="num"><b>{money(s.schedule.disbursement.disbursed)}</b> <span className="subtle">of {money(s.schedule.disbursement.stopped ? s.schedule.disbursement.final : s.schedule.disbursement.planned)} · {s.schedule.disbursement.count}/{s.schedule.disbursement.total} increments × {money(s.schedule.disbursement.perIncrement)}</span></span></div>
                <div className="paidin wide"><i style={{ width: `${Math.round((s.schedule.disbursement.count / Math.max(1, s.schedule.disbursement.total)) * 100)}%`, background: 'var(--teal)' }} /></div>
                {s.schedule.planned && <div className="subtle" style={{ fontSize: 12.5, marginTop: 4 }}>Merchant opted out after {s.schedule.disbursement.total} of {s.schedule.planned.increments} — entered as {money(s.schedule.planned.amount)}, now a {money(s.schedule.disbursement.final)} deal; commission {money(s.schedule.planned.gross)} → {money(s.gross)}.</div>}
              </div>
              <div className="pips">{s.schedule.events.filter((e) => e.kind === 'increment').map((e) => <i key={e.n} className={e.received ? 'on' : e.overdue ? 'late' : ''} title={`${e.label} · ${e.expected ? fullDay(e.expected) : '—'}${e.amount ? ` · ${money(e.amount)}` : ''}${e.received ? ' · received' : e.overdue ? ' · overdue' : ''}`} />)}</div>
              <dl className="kv" style={{ marginTop: 12 }}>
                {s.schedule.upfrontPct > 0 && <><dt>Upfront {money(s.schedule.upfrontAmount)}</dt><dd style={{ fontFamily: 'var(--sans)' }}>{s.schedule.upfrontReceived ? <span className="pos">received</span> : <button className="btn" style={{ height: 26, padding: '0 8px', fontSize: 13.5 }} onClick={() => void collect({ segmentKey: s.sk, markUpfront: true }, `${d.id} — upfront ${money(s.schedule!.upfrontAmount)} received`)}>Record upfront received</button>}</dd></>}
                <dt>Lender paid</dt><dd>{s.schedule.received}/{s.schedule.weeks} increments{s.schedule.remainder === 'spread' ? ` · ${money(s.schedule.perWeek * s.schedule.received)}` : ''}</dd>
                <dt>Collected so far</dt><dd>{money(s.collected)} <span className="subtle">of {money(s.gross)}</span></dd>
                {s.schedule.paidToReps.length > 0 && <><dt>Rep paid</dt><dd style={{ fontFamily: 'var(--sans)' }}>{s.schedule.paidToReps.map((r) => <div key={r.role}><span className="num">{r.paid}/{r.total}</span> <span className="subtle">{r.name} · {r.role}</span></div>)}</dd></>}
                <dt>Still to come</dt><dd>{money(s.outstanding)}</dd>
                <dt>Next expected</dt><dd>{s.schedule.nextExpected ? <>{s.schedule.nextExpected.expected ? day(s.schedule.nextExpected.expected) : '—'} <span className="subtle" style={{ fontFamily: 'var(--sans)' }}>· {s.schedule.nextExpected.label}{s.schedule.nextExpected.amount ? ` · ${money(s.schedule.nextExpected.amount)}` : ''}{s.schedule.nextExpected.overdue ? <b className="neg"> · overdue</b> : ''}</span></> : <span className="pos">Complete</span>}</dd>
                {s.schedule.remainder === 'at-end' && <><dt>Final {money(s.schedule.remainderAmount)}</dt><dd style={{ fontFamily: 'var(--sans)' }}>{s.schedule.remainderReceived ? <span className="pos">received</span> : s.schedule.received >= s.schedule.weeks ? <button className="btn primary" style={{ height: 26, padding: '0 8px', fontSize: 13.5 }} onClick={() => void collect({ segmentKey: s.sk, markRemainder: true }, `${d.id} — final ${money(s.schedule!.remainderAmount)} received`)}>Record final received</button> : <span className="subtle">due when increments are done</span>}</dd></>}
              </dl>
              <details style={{ marginTop: 10 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 14 }}>Increment grid {s.schedule.amounts ? '· uneven' : '· equal'}</summary>
                <GridEditor current={s.schedule.amounts} planned={s.schedule.planned?.amount ?? s.amount} count={s.schedule.planned?.increments ?? s.schedule.weeks} onApply={(amounts) => collect({ segmentKey: s.sk, amounts }, `${d.id} — increment grid ${amounts ? 'updated' : 'reset to equal increments'}`)} />
              </details>
              <details style={{ marginTop: 10 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 14 }}>Expected receipts ({s.schedule.events.length})</summary>
                <div className="pl" style={{ marginTop: 6 }}>
                  {s.schedule.events.map((e) => (
                    <div className="row" key={`${e.kind}-${e.n}`} style={{ gridTemplateColumns: 'minmax(0,1fr) 90px 110px 100px 90px' }}>
                      <span className={e.overdue ? 'neg' : ''}>{e.label}</span>
                      <span className="num subtle">{e.expected ? day(e.expected) : '—'}</span>
                      <span className="num subtle" title="Disbursed to the merchant at this increment">{e.funding !== undefined ? money(e.funding) : ''}</span>
                      <span className="num">{e.amount ? money(e.amount) : <span className="subtle">progress</span>}</span>
                      <Pill tone={e.received ? 'teal' : e.overdue ? 'red' : 'grey'}>{e.received ? 'Received' : e.overdue ? 'Overdue' : 'Expected'}</Pill>
                    </div>
                  ))}
                </div>
              </details>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn primary" disabled={s.schedule.received >= s.schedule.weeks} onClick={() => void collect({ segmentKey: s.sk, recordWeeks: 1 }, `${d.id} — increment ${s.schedule!.received + 1} of ${s.schedule!.weeks} received`)}>Record increment received</button>
                <button className="btn" disabled={s.schedule.received <= 0} onClick={() => void collect({ segmentKey: s.sk, recordWeeks: -1 }, `${d.id} — last increment reversed`)}>Reverse last</button>
                {s.schedule.disbursement.stopped
                  ? <button className="btn" onClick={() => void collect({ segmentKey: s.sk, stopIncrements: false }, `${d.id} — plan reopened to ${s.schedule!.planned?.increments ?? s.schedule!.weeks} increments`)}>Reopen full plan</button>
                  : <button className="btn" disabled={s.schedule.received >= s.schedule.weeks} title="The merchant is not taking the rest: the deal becomes what was disbursed so far" onClick={() => void collect({ segmentKey: s.sk, stopIncrements: true }, `${d.id} — merchant opted out after ${s.schedule!.received} increments`)}>Merchant opted out</button>}
              </div>
            </section>
          ))}

          {(d.drawSubsequentPct || d.drawCount > 0) && (
            <section className="card">
              <h3>Draw ledger <small>one opportunity · {d.segments.length} segment{d.segments.length > 1 ? 's' : ''}</small></h3>
              <div className="pl">
                {d.segments.map((s) => (
                  <div className="row draw" key={s.sk}>
                    <span><b>{s.label}</b> <span className="subtle num">{day(s.date)}</span>{s.payment != null && <div className="subtle" style={{ fontSize: 13 }}>{s.termDays} days · {s.factor?.toFixed(2)} · {money(s.payback ?? 0)} payback · <b className="num">{money(s.payment)}</b> / {d.frequency.toLowerCase()}</div>}</span>
                    <span className="num">{money(s.amount)}</span>
                    <span className="num subtle">{pct(s.commRate)}</span>
                    <span className="num">{money(s.net)}</span>
                    <button className={`pill ${toneFor(s.lenderPaidLabel === 'Collected' ? 'Paid' : s.status)}`} style={{ cursor: 'pointer' }} onClick={() => void collect({ segmentKey: s.sk, toggle: true }, `${d.id} ${s.sk} — collection updated`)}>{s.lenderPaidLabel}</button>
                  </div>
                ))}
                <div className="row draw total"><span>Total</span><span className="num">{money(d.funded)}</span><span /><span className="num">{money(d.net)}</span><span className="subtle">{money(d.outstanding)} outstanding</span></div>
              </div>
              {d.drawSubsequentPct && (() => {
                const amt = num(drawAmount);
                const term = num(drawTerm) || null;
                const factor = num(drawFactor) || null;
                const payback = amt && factor ? paybackOf({ amount: amt, factor }) : null;
                const payment = paymentFor({ payback, termDays: term, frequency: d.frequency });
                return (
                  <div className="add-draw">
                    <div className="form" style={{ gridTemplateColumns: '1.4fr 1fr 1fr' }}>
                      <label className="field"><span className="label">Draw amount</span><input inputMode="decimal" placeholder="25000" value={drawAmount} onChange={(e) => setDrawAmount(e.target.value)} /></label>
                      <label className="field"><span className="label">Term (bus. days) · optional</span><input inputMode="numeric" placeholder={d.termDays ? String(d.termDays) : '—'} value={drawTerm} onChange={(e) => setDrawTerm(e.target.value)} /></label>
                      <label className="field"><span className="label">Factor rate · optional</span><input inputMode="decimal" placeholder={d.factor ? d.factor.toFixed(2) : '—'} value={drawFactor} onChange={(e) => setDrawFactor(e.target.value)} /></label>
                    </div>
                    <div className="draw-math">
                      <div><span className="label">Commission</span><b className="num">{money(amt * d.drawSubsequentPct)}</b><span className="subtle">at {pct(d.drawSubsequentPct)}</span></div>
                      <div><span className="label">Payback</span><b className="num">{payback === null ? '—' : money(payback)}</b><span className="subtle">{factor ? `${money(amt)} × ${factor}` : 'needs a factor rate'}</span></div>
                      <div><span className="label">Payment</span><b className="num">{payment === null ? '—' : money(payment)}</b><span className="subtle">{payment === null ? 'needs term + factor' : `per ${d.frequency.toLowerCase()} · ${term} bus. days`}</span></div>
                      <button className="btn primary" disabled={!amt} onClick={() => run(`Draw added to ${d.id}`, async () => { await post(`/api/admin/deals/${id}/draws`, { amount: amt, termDays: term, factor }); setDrawAmount(''); setDrawTerm(''); setDrawFactor(''); })}>Add draw at {pct(d.drawSubsequentPct)}</button>
                    </div>
                  </div>
                );
              })()}
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
                    <span className={p.amount < 0 ? 'neg' : ''}>{p.repName} · {p.role}{p.segmentKey && p.segmentKey !== 'base' ? ` · ${p.segmentKey}` : ''}{p.unit ? <span className="subtle"> · {p.unit}</span> : ''}</span>
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

/** Paste or type the increment grid on an existing deal. It must total the plan's funded amount. */
function GridEditor({ current, planned, count, onApply }: { current: number[] | null; planned: number; count: number; onApply: (amounts: number[] | null) => Promise<void> | void }) {
  const [text, setText] = useState(current ? current.join('\n') : '');
  useEffect(() => setText(current ? current.join('\n') : ''), [current]);
  const grid = text.trim() ? parseIncrementGrid(text) : [];
  const total = grid.reduce((a, b) => a + b, 0);
  const mismatch = grid.length > 0 && Math.abs(total - planned) > 1;
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
      <div className="subtle" style={{ fontSize: 13 }}>{current ? `Uneven disbursements over ${current.length} increments.` : `Equal increments of ${money(planned / Math.max(1, count))}.`} Paste one amount per line, or "12500 x15" to repeat. The grid must total {money(planned)}.</div>
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={'12500 x15\n8000 x3\n5000 x2'} style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', background: 'var(--input-bg)', color: 'inherit', font: 'inherit', fontFamily: 'var(--mono)', fontSize: 13.5, resize: 'vertical', outline: 'none', borderColor: mismatch ? 'var(--red)' : undefined }} />
      {grid.length > 0 && <div className="gridpreview">{grid.map((a, i) => <span key={i} title={`Increment ${i + 1} · ${money(a)}`} style={{ height: `${Math.max(8, Math.round((a / Math.max(...grid)) * 40))}px` }} />)}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn primary" disabled={!grid.length || mismatch} onClick={() => void onApply(grid)}>Apply grid</button>
        {current && <button className="btn" onClick={() => void onApply(null)}>Back to equal increments</button>}
        <span className={`num ${mismatch ? 'neg' : 'subtle'}`} style={{ fontSize: 13 }}>{grid.length ? `${grid.length} increments · ${money(total)}${mismatch ? ` ≠ ${money(planned)}` : ''}` : ''}</span>
      </div>
    </div>
  );
}
