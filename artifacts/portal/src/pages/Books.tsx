import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AdminDealDrawer } from '../components/AdminDealDrawer';
import { Shell } from '../components/Shell';
import { Card, Loading, Metric, Pill } from '../components/ui';
import { DEMO, EXCEPTION_LABEL, EXCEPTION_SHORT, api, post, type AgeBucket, type CashView, type ExceptionKind, type Exceptions, type PartnerPayables, type Receivables, type Settings } from '../lib/api';
import { compact, day, money, monthLabel } from '../lib/format';
import { useSession } from '../lib/session';

type Tab = 'exceptions' | 'receivables' | 'partners' | 'cash';
const TABS: Array<{ key: Tab; label: string; hint: string }> = [
  { key: 'exceptions', label: 'Exceptions', hint: 'What a bookkeeper would find by reading every row: funded with nothing received, reps paid ahead of the lender, matured deals still marked Performing, clawback windows closing, overdue receipts, partner fees due.' },
  { key: 'receivables', label: 'Receivables', hint: 'What each lender still owes the house, aged from the date it was expected — the schedule for incremental lenders, funded date plus the lender’s payment terms for everyone else.' },
  { key: 'partners', label: 'Partner payables', hint: 'Referral fees owed per partner. Tick the deals you paid and mark them paid; the audit log keeps the date.' },
  { key: 'cash', label: 'Cash & export', hint: 'Month by month: what was earned on deals funded that month (accrual) beside what reps were actually paid (cash). Export a journal CSV for QuickBooks or your accountant.' },
];
const BUCKETS: AgeBucket[] = ['current', '1-30', '31-60', '61-90', '90+'];

export function Books() {
  const [tab, setTab] = useState<Tab>('exceptions');
  const [open, setOpen] = useState<string | null>(null);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  return (
    <Shell eyebrow="Admin" title="Books">
      <div className="seg pagetabs">{TABS.map((t) => <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>)}</div>
      <div className="muted" style={{ marginTop: -6 }}>{TABS.find((t) => t.key === tab)!.hint}</div>
      {tab === 'exceptions' && <ExceptionsTab onOpen={setOpen} />}
      {tab === 'receivables' && <ReceivablesTab onOpen={setOpen} />}
      {tab === 'partners' && <PartnersTab onOpen={setOpen} />}
      {tab === 'cash' && <CashTab />}
      {open && settings.data && <AdminDealDrawer id={open} settings={settings.data} editOptions={[]} onClose={() => setOpen(null)} />}
    </Shell>
  );
}

function ExceptionsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['books-exceptions'], queryFn: () => api<Exceptions>('/api/admin/books/exceptions') });
  const [kind, setKind] = useState<ExceptionKind | 'all'>('all');
  const x = q.data;
  if (!x) return <Loading error={q.error} />;
  const kinds = Object.keys(EXCEPTION_LABEL) as ExceptionKind[];
  const rows = x.items.filter((i) => kind === 'all' || i.kind === kind);
  return (
    <>
      <div className="grid-auto-180">
        {kinds.map((k) => (
          <button key={k} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', borderColor: kind === k ? 'var(--teal)' : undefined, boxShadow: kind === k ? '0 0 0 1px var(--teal)' : undefined }} onClick={() => setKind(kind === k ? 'all' : k)}>
            <div className="label">{EXCEPTION_LABEL[k]}</div>
            <div className={`metric ${x.counts[k] ? 'neg' : ''}`}>{x.counts[k]}</div>
            <div className="sub">{x.counts[k] ? money(x.totals[k]) : 'clear'}</div>
          </button>
        ))}
      </div>
      <Card title={kind === 'all' ? 'Everything that needs a look' : EXCEPTION_LABEL[kind]} extra={`${rows.length} item${rows.length === 1 ? '' : 's'} · as of ${day(x.asOf)}`}>
        {rows.length === 0 ? <div className="muted">Nothing here. The books are clean on this point.</div> : (
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: 'minmax(220px,1.2fr) 170px 110px 70px minmax(280px,2fr)', minWidth: 900 }}>
              <div className="tr th"><div className="td">Deal</div><div className="td">Flag</div><div className="td r">Amount</div><div className="td r">Days</div><div className="td">Detail</div></div>
              {rows.map((i, n) => (
                <div className="tr click" key={`${i.kind}-${i.dealId}-${n}`} onClick={() => onOpen(i.dealId)}>
                  <div className="td ellipsis"><b>{i.business}</b> <span className="subtle num">{i.dealId} · {i.lender}</span></div>
                  <div className="td"><Pill tone={i.kind === 'clawback-closing' ? 'amber' : 'red'}>{EXCEPTION_SHORT[i.kind]}</Pill></div>
                  <div className="td r num">{money(i.amount)}</div>
                  <div className="td r num subtle">{i.days}</div>
                  <div className="td ellipsis subtle">{i.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function ReceivablesTab({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['books-receivables'], queryFn: () => api<Receivables>('/api/admin/books/receivables') });
  const [lender, setLender] = useState<string>('');
  const r = q.data;
  if (!r) return <Loading error={q.error} />;
  const rows = r.rows.filter((x) => !lender || x.lender === lender);
  return (
    <>
      <div className="grid-auto-180">
        <Metric label="Outstanding from lenders" value={money(r.total)} sub={`as of ${day(r.asOf)}`} />
        {BUCKETS.map((b) => <Metric key={b} label={b === 'current' ? 'Not yet due' : `${b} days late`} value={money(r.byBucket[b])} tone={b !== 'current' && r.byBucket[b] ? (b === '1-30' ? 'warn' : 'neg') : undefined} />)}
      </div>
      <div className="two">
        <Card title="What to chase" extra={lender ? `${lender} only` : 'oldest first'}>
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: 'minmax(200px,1.3fr) 120px 130px 100px 100px 80px', minWidth: 760 }}>
              <div className="tr th"><div className="td">Deal</div><div className="td">Item</div><div className="td">Segment</div><div className="td r">Expected</div><div className="td r">Amount</div><div className="td r">Late</div></div>
              {rows.map((x, i) => (
                <div className="tr click" key={`${x.dealId}-${x.segment}-${x.item}-${i}`} onClick={() => onOpen(x.dealId)}>
                  <div className="td ellipsis"><b>{x.business}</b> <span className="subtle num">{x.dealId} · {x.lender}</span></div>
                  <div className="td">{x.item}</div>
                  <div className="td subtle ellipsis">{x.segment}</div>
                  <div className="td r num subtle">{day(x.expected)}</div>
                  <div className="td r num">{money(x.amount)}</div>
                  <div className={`td r num ${x.daysOverdue > 30 ? 'neg' : x.daysOverdue ? 'warn' : 'subtle'}`}>{x.daysOverdue ? `${x.daysOverdue}d` : '—'}</div>
                </div>
              ))}
              {rows.length === 0 && <div className="empty">Nothing outstanding.</div>}
            </div>
          </div>
        </Card>
        <Card title="By lender" extra="click a lender to filter · terms from Settings › Lenders">
          <div className="pl">
            {r.byLender.map((l) => (
              <div className="row click" key={l.lender} style={{ cursor: 'pointer', background: lender === l.lender ? 'var(--row-selected)' : undefined }} onClick={() => setLender(lender === l.lender ? '' : l.lender)}>
                <span><b>{l.lender}</b><span className="subtle"> · pays in {l.termsDays} days · {l.rows} open</span></span>
                <span className={`num ${l.overdue ? 'neg' : 'subtle'}`}>{l.overdue ? `${money(l.overdue)} late` : ''}</span>
                <span className="num">{money(l.outstanding)}</span>
              </div>
            ))}
            {r.byLender.length === 0 && <div className="muted">Every lender is paid up.</div>}
          </div>
        </Card>
      </div>
    </>
  );
}

function PartnersTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['books-partners'], queryFn: () => api<PartnerPayables>('/api/admin/books/partners') });
  const [partner, setPartner] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [showPaid, setShowPaid] = useState(false);
  const p = q.data;
  if (!p) return <Loading error={q.error} />;
  const rows = p.rows.filter((r) => (!partner || r.partner === partner) && (showPaid || !r.paidAt));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function mark(paid: boolean) {
    try {
      const r = await post<{ updated: number }>('/api/admin/books/partners/pay', { dealIds: [...picked], paid, date });
      notify(paid ? `${r.updated} fee${r.updated === 1 ? '' : 's'} marked paid on ${day(date)}` : `${r.updated} fee${r.updated === 1 ? '' : 's'} back to owed`);
      setPicked(new Set());
      await qc.invalidateQueries({ queryKey: ['books-partners'] });
      await qc.invalidateQueries({ queryKey: ['books-exceptions'] });
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update');
    }
  }
  const pickedTotal = p.rows.filter((r) => picked.has(r.dealId)).reduce((s, r) => s + r.fee, 0);
  return (
    <>
      <div className="grid-auto-180">
        <Metric label="Owed to partners" value={money(p.totals.owed)} tone={p.totals.owed ? 'warn' : undefined} sub="referral fees not yet paid out" />
        <Metric label="Payable now" value={money(p.totals.owedCollected)} tone={p.totals.owedCollected ? 'neg' : undefined} sub="owed, and the commission has landed" />
        <Metric label="Paid out" value={money(p.totals.paid)} sub="lifetime" />
      </div>
      <div className="two">
        <Card title="Fees by deal" extra={<span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500 }}><input type="checkbox" checked={showPaid} onChange={(e) => setShowPaid(e.target.checked)} />show paid</label></span>}>
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: '36px minmax(200px,1.3fr) 130px 110px 120px 100px', minWidth: 720 }}>
              <div className="tr th"><div className="td" /><div className="td">Deal</div><div className="td">Partner</div><div className="td r">Fee</div><div className="td">Commission</div><div className="td r">Paid</div></div>
              {rows.map((r) => (
                <div className="tr" key={r.dealId}>
                  <div className="td"><input type="checkbox" checked={picked.has(r.dealId)} onChange={() => toggle(r.dealId)} /></div>
                  <div className="td ellipsis click" style={{ cursor: 'pointer' }} onClick={() => onOpen(r.dealId)}><b>{r.business}</b> <span className="subtle num">{r.dealId} · {r.lender} · {day(r.fundedDate)}</span></div>
                  <div className="td ellipsis">{r.partner}</div>
                  <div className="td r num">{money(r.fee)}</div>
                  <div className="td"><Pill tone={r.collected ? 'teal' : 'amber'}>{r.collected ? 'Collected' : r.commissionStatus}</Pill></div>
                  <div className={`td r num ${r.paidAt ? 'pos' : 'subtle'}`}>{r.paidAt ? day(r.paidAt) : 'owed'}</div>
                </div>
              ))}
              {rows.length === 0 && <div className="empty">Nothing owed{partner ? ` to ${partner}` : ''}.</div>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <span className="subtle" style={{ fontSize: 13 }}>{picked.size ? `${picked.size} picked · ${money(pickedTotal)}` : 'Tick the deals you paid'}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 150 }} />
            <button className="btn primary" disabled={!picked.size} onClick={() => void mark(true)}>Mark paid</button>
            <button className="btn" disabled={!picked.size} onClick={() => void mark(false)}>Back to owed</button>
          </div>
        </Card>
        <Card title="By partner" extra="click to filter">
          <div className="pl">
            {p.partners.map((x) => (
              <div className="row click" key={x.partner} style={{ cursor: 'pointer', background: partner === x.partner ? 'var(--row-selected)' : undefined }} onClick={() => setPartner(partner === x.partner ? '' : x.partner)}>
                <span><b>{x.partner}</b><span className="subtle"> · {Math.round(x.pct * 1000) / 10}% · {x.deals} deal{x.deals === 1 ? '' : 's'}{x.active ? '' : ' · retired'}</span></span>
                <span className="subtle num">{x.owedCollected ? `${money(x.owedCollected)} now` : ''}</span>
                <span className={`num ${x.owed ? 'warn' : 'subtle'}`}>{money(x.owed)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function CashTab() {
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const q = useQuery({ queryKey: ['books-cash', year], queryFn: () => api<CashView>(`/api/admin/books/cash?year=${year}`) });
  const v = q.data;
  if (!v) return <Loading error={q.error} />;
  const months = v.months.filter((m) => m.deals || m.repPayouts || m.recovered);
  const t = v.total;
  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ width: 110 }}>{[0, 1, 2, 3].map((k) => { const y = new Date().getUTCFullYear() - k; return <option key={y} value={y}>{y}</option>; })}</select>
        {DEMO ? <span className="subtle" style={{ fontSize: 13 }}>CSV export is available on the live portal.</span> : <a className="btn" href={`/api/admin/books/cash.csv?year=${year}`} download>Export journal CSV (QuickBooks)</a>}
        <span className="subtle" style={{ fontSize: 13 }}>One line per event: commission income by lender, referral fees, rep payouts, clawback recoveries.</span>
      </div>
      <div className="grid-auto-180">
        <Metric label="Gross commission earned" value={compact(t.grossEarned)} sub={`${t.deals} deals · ${compact(t.funded)} funded`} />
        <Metric label="Referral fees" value={compact(t.referralFees)} tone={t.referralFees ? 'warn' : undefined} sub="accrued on those deals" />
        <Metric label="Rep shares" value={compact(t.repShares)} sub="earned by reps on those deals" />
        <Metric label="House net" value={compact(t.houseNet)} tone="pos" sub="gross − referral − rep shares" />
        <Metric label="Collected / outstanding" value={`${compact(t.collected)} / ${compact(t.outstanding)}`} tone={t.outstanding ? 'warn' : undefined} sub="from lenders, on this year’s deals" />
        <Metric label="Paid to reps (cash)" value={compact(t.repCash)} sub={`${compact(t.repPayouts)} paid − ${compact(t.recovered)} recovered`} />
      </div>
      <Card title={`${v.year} by month`} extra="accrual columns by funded month · cash columns by payout date">
        <div className="scroller">
          <div className="table" style={{ ['--cols' as string]: '110px 60px repeat(10, 105px)', minWidth: 1220 }}>
            <div className="tr th"><div className="td">Month</div><div className="td r">Deals</div><div className="td r">Funded</div><div className="td r">Gross earned</div><div className="td r">Referral</div><div className="td r">Rep shares</div><div className="td r">House net</div><div className="td r">Collected</div><div className="td r">Outstanding</div><div className="td r">Rep payouts</div><div className="td r">Recovered</div><div className="td r">Rep cash</div></div>
            {months.map((m) => (
              <div className="tr" key={m.month}>
                <div className="td">{monthLabel(m.month)}</div>
                <div className="td r num">{m.deals}</div>
                <div className="td r num">{compact(m.funded)}</div>
                <div className="td r num">{money(m.grossEarned)}</div>
                <div className="td r num subtle">{money(m.referralFees)}</div>
                <div className="td r num subtle">{money(m.repShares)}</div>
                <div className="td r num pos">{money(m.houseNet)}</div>
                <div className="td r num">{money(m.collected)}</div>
                <div className={`td r num ${m.outstanding ? 'warn' : 'subtle'}`}>{money(m.outstanding)}</div>
                <div className="td r num">{money(m.repPayouts)}</div>
                <div className={`td r num ${m.recovered ? 'neg' : 'subtle'}`}>{money(m.recovered)}</div>
                <div className="td r num">{money(m.repCash)}</div>
              </div>
            ))}
            {months.length === 0 && <div className="empty">Nothing in {v.year} yet.</div>}
            <div className="tr total">
              <div className="td">Total</div>
              <div className="td r num">{t.deals}</div>
              <div className="td r num">{compact(t.funded)}</div>
              <div className="td r num">{money(t.grossEarned)}</div>
              <div className="td r num">{money(t.referralFees)}</div>
              <div className="td r num">{money(t.repShares)}</div>
              <div className="td r num pos">{money(t.houseNet)}</div>
              <div className="td r num">{money(t.collected)}</div>
              <div className="td r num">{money(t.outstanding)}</div>
              <div className="td r num">{money(t.repPayouts)}</div>
              <div className="td r num">{money(t.recovered)}</div>
              <div className="td r num">{money(t.repCash)}</div>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
