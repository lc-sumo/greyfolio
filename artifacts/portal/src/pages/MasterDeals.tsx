import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { AdminDealDrawer } from '../components/AdminDealDrawer';
import { NewDealDrawer } from '../components/NewDealDrawer';
import { Shell } from '../components/Shell';
import { Card, ClawbackBar, Contact, Empty, Loading, toneFor } from '../components/ui';
import { DEAL_STATUS_OPTIONS, api, post, qs, type MasterBoard, type Settings } from '../lib/api';
import { compact, day, money, pct } from '../lib/format';
import { useSession } from '../lib/session';

const COLS = '120px 70px 84px minmax(200px,1.3fr) minmax(240px,1.3fr) 130px minmax(170px,1fr) 110px 70px 70px 100px 100px 100px minmax(150px,1fr) minmax(150px,1fr) minmax(150px,1fr) 110px 110px 150px 170px minmax(0,1fr)';

export function MasterDeals() {
  const { notify } = useSession();
  const [search, setSearch] = useState('');
  const [rep, setRep] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  const board = useQuery({ queryKey: ['master', rep, status], queryFn: () => api<MasterBoard>(`/api/admin/deals${qs({ rep, status })}`) });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (board.data?.deals ?? []).filter((d) => !s || `${d.id} ${d.crmId ?? ''} ${d.business} ${d.merchantContact} ${d.merchantEmail} ${d.merchantPhone} ${d.lender} ${d.product}`.toLowerCase().includes(s));
  }, [board.data, search]);
  const totals = rows.reduce((t, d) => ({ funded: t.funded + d.funded, gross: t.gross + d.gross, net: t.net + d.net, payout: t.payout + d.totalRepPayout, house: t.house + d.houseNet }), { funded: 0, gross: 0, net: 0, payout: 0, house: 0 });
  const collect = async (id: string, body: Record<string, unknown>, label: string) => {
    try {
      await post(`/api/admin/deals/${id}/collection`, body);
      await board.refetch();
      notify(label);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update');
    }
  };

  return (
    <Shell eyebrow="Admin" title="Master deals">
      <Card>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <input className="search" placeholder="Search deal, business, merchant contact, email, phone" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 320 }} />
          <select className="filter" value={rep} onChange={(e) => setRep(e.target.value)}>
            <option value="">All reps</option>
            {(board.data?.repOptions.edit ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <select className="filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['Waiting for payment', 'Partially Paid', 'YES - Paid In Full', 'Performing', 'Prospecting', 'Refi Ready', 'Refinanced', 'Default', 'Slow Pay', 'Paid In Full'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <span className="count">{rows.length} of {board.data?.count ?? 0} deals</span>
          <button className="btn primary" onClick={() => setCreating(true)} disabled={!settings.data || !board.data}>+ New deal</button>
        </div>
        {!board.data ? <Loading error={board.error} /> : rows.length === 0 ? <Empty>No deals match.</Empty> : (
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: COLS, minWidth: 2450 }}>
              <div className="tr th">
                {['Deal ID', 'Sheet #', 'Date', 'Business', 'Merchant contact', 'Lender', 'Product', 'Funded', 'Factor / APR', 'Comm %', 'Gross', 'Referral', 'Net', 'Opener', 'Closer', 'Override', 'Rep payout', 'House net', 'Lender paid comm', 'Commission status', 'Deal status'].map((h, i) => (
                  <div className={`td ${[7, 10, 11, 12, 16, 17].includes(i) ? 'r' : ''}`} key={h}>{h}</div>
                ))}
              </div>
              {rows.map((d) => (
                <div className={`tr ${d.atRisk ? 'tint' : ''}`} key={d.id}>
                  <div className="td num" style={{ cursor: 'pointer' }} onClick={() => setOpen(d.id)}>{d.crmId ?? <span className="subtle">—</span>}{d.crmUrl && <a href={d.crmUrl} target="_blank" rel="noopener" className="crm-mini" onClick={(e) => e.stopPropagation()} title="Open in CRM">↗</a>}{d.hasClawback && <span className="neg" title="Clawback"> ●</span>}</div>
                  <div className="td num subtle" style={{ cursor: 'pointer' }} onClick={() => setOpen(d.id)}>{d.id}</div>
                  <div className="td num">{day(d.date)}</div>
                  <div className="td ellipsis" style={{ cursor: 'pointer' }} onClick={() => setOpen(d.id)}><b>{d.business}</b>{d.drawCount > 0 && <span className="subtle"> · {d.drawCount} draw{d.drawCount > 1 ? 's' : ''}</span>}</div>
                  <div className="td contact-cell"><Contact name={d.merchantContact} email={d.merchantEmail} phone={d.merchantPhone} /></div>
                  <div className="td ellipsis">{d.lender}</div>
                  <div className="td ellipsis">{d.product}</div>
                  <div className="td r num">{money(d.funded)}{d.increments && <div className={`subtle ${d.increments.stopped ? 'warn' : ''}`} style={{ fontSize: 12.5, marginTop: 2 }} title={`${money(d.increments.perIncrement)} per increment`}>{d.increments.stopped ? `opted out · ${d.increments.total} of ${Math.round(d.increments.planned / d.increments.perIncrement)}` : `${money(d.increments.disbursed)} out · ${d.increments.lenderPaid}/${d.increments.total}`}</div>}</div>
                  <div className="td num">{d.factor !== null ? d.factor.toFixed(2) : d.apr !== null ? `${d.apr}%` : '—'}</div>
                  <div className="td num">{pct(d.commRate)}</div>
                  <div className="td r num">{money(d.gross)}</div>
                  <div className="td r num subtle">{d.referralFee ? `${money(d.referralFee)}` : '—'}</div>
                  <div className="td r num">{money(d.net)}</div>
                  {d.roles.map((r) => (
                    <div className="td ellipsis" key={r.role}>{r.repId ? <><span className="ellipsis">{r.name}</span><div className="subtle num" style={{ fontSize: 13 }}>{pct(r.rate)} · {money(r.amount)}</div></> : <span className="subtle">—</span>}</div>
                  ))}
                  <div className="td r num">{money(d.totalRepPayout)}</div>
                  <div className="td r num pos">{money(d.houseNet)}</div>
                  <div className="td"><button className={`pill ${d.overdueReceipts ? 'red' : toneFor(d.lenderPaidLabel === 'Collected' ? 'Paid' : d.commissionStatus)}`} title={d.overdueReceipts ? `${d.overdueReceipts} lender receipt(s) overdue · ${money(d.overdueAmount)}` : undefined} style={{ cursor: 'pointer' }} onClick={() => void collect(d.id, { segmentKey: 'base', toggle: true }, `${d.id} — collection updated`)}>{d.lenderPaidLabel}{d.overdueReceipts ? ' · late' : ''}</button>{d.increments && <div className="subtle num" style={{ fontSize: 12.5, marginTop: 3 }}>Lender {d.increments.lenderPaid}/{d.increments.total} · Rep {d.increments.repPaid}/{d.increments.total}</div>}</div>
                  <div className="td"><select className="mini" value={d.commissionStatus} onChange={(e) => void collect(d.id, { segmentKey: 'base', status: e.target.value }, `${d.id} — commission ${e.target.value.toLowerCase()}`)}>{['Waiting for payment', 'Partially Paid', 'YES - Paid In Full'].map((s) => <option key={s}>{s}</option>)}</select></div>
                  <div className="td"><select className="mini" value={d.storedDealStatus === 'Performing' || d.storedDealStatus === 'Prospecting' || d.storedDealStatus === 'Refi Ready' ? 'Performing' : d.storedDealStatus} title={`Showing ${d.dealStatus}`} onChange={async (e) => { try { await post(`/api/admin/deals/${d.id}/status`, { dealStatus: e.target.value }, 'PATCH'); await board.refetch(); notify(`${d.id} — ${e.target.value}`); } catch (x) { notify(x instanceof Error ? x.message : 'Could not update'); } }}>{DEAL_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.value === 'Performing' ? `Auto · ${d.dealStatus}` : o.label}</option>)}</select><div style={{ marginTop: 5 }}>{d.clawbackWindow.cleared ? <span className="cleared"><i>✓</i> {d.clawbackWindow.basis === 'none' ? 'No clawback' : 'Clawback cleared'}</span> : <><ClawbackBar fundedDate={d.date} win={d.clawbackWindow} /><div className="subtle num" style={{ fontSize: 12.5, marginTop: 3 }}>clawback · {d.clawbackWindow.daysLeft}d left</div></>}</div></div>
                </div>
              ))}
              <div className="tr total">
                <div className="td" style={{ gridColumn: '1 / 8' }}>{rows.length} opportunities · {rows.reduce((s, d) => s + d.drawCount, 0)} draw lines</div>
                <div className="td r num">{compact(totals.funded)}</div><div className="td" /><div className="td" />
                <div className="td r num">{money(totals.gross)}</div><div className="td" /><div className="td r num">{money(totals.net)}</div>
                <div className="td" /><div className="td" /><div className="td" />
                <div className="td r num">{money(totals.payout)}</div><div className="td r num pos">{money(totals.house)}</div>
                <div className="td" /><div className="td" /><div className="td" />
              </div>
            </div>
          </div>
        )}
        <div className="subtle" style={{ marginTop: 10, fontSize: 13.5 }}>Rows tinted red are inside the {settings.data?.thresholds.clawbackWindowDays ?? 30}-day clawback window or flagged slow-pay. Deal status follows the dates (Performing → Prospecting at {settings.data?.thresholds.additionalCapitalAfterDays ?? 30} days → Refi Ready at {Math.round((settings.data?.thresholds.renewalMark ?? 0.4) * 100)}% paid in) unless set by hand. Click the lender-paid pill to record a week (weekly lenders) or toggle collected (upfront). The status select writes collection — it never sets a status on its own.</div>
      </Card>
      {open && settings.data && board.data && <AdminDealDrawer id={open} settings={settings.data} editOptions={board.data.repOptions.edit} onClose={() => setOpen(null)} />}
      {creating && settings.data && board.data && <NewDealDrawer settings={settings.data} board={board.data} onClose={() => setCreating(false)} onSaved={(d) => { setCreating(false); setOpen(d.id); }} />}
    </Shell>
  );
}
