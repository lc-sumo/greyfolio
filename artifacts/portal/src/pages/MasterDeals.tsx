import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { AdminDealDrawer } from '../components/AdminDealDrawer';
import { NewDealDrawer } from '../components/NewDealDrawer';
import { Shell } from '../components/Shell';
import { Card, ClawbackBar, Contact, Empty, Loading, toneFor } from '../components/ui';
import { DEAL_STATUS_OPTIONS, api, post, qs, type MasterBoard, type Settings } from '../lib/api';
import { compact, day, money, pct } from '../lib/format';
import { useSession } from '../lib/session';

const PRIMARY_COLS = 'minmax(92px, .75fr) minmax(180px, 1.8fr) minmax(130px, 1.05fr) minmax(100px, .8fr) minmax(92px, .8fr) minmax(92px, .8fr) minmax(92px, .8fr) minmax(120px, 1fr) 32px';
const statusOptions = ['Waiting for payment', 'Partially Paid', 'YES - Paid In Full', 'Performing', 'Prospecting', 'Refi Ready', 'Refinanced', 'Default', 'Slow Pay', 'Paid In Full'];

export function MasterDeals() {
  const { notify } = useSession();
  const [search, setSearch] = useState('');
  const [rep, setRep] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  const board = useQuery({ queryKey: ['master', rep, status], queryFn: () => api<MasterBoard>(`/api/admin/deals${qs({ rep, status })}`) });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (board.data?.deals ?? []).filter((d) => !s || `${d.id} ${d.crmId ?? ''} ${d.business} ${d.merchantContact} ${d.merchantEmail} ${d.merchantPhone} ${d.lender} ${d.product}`.toLowerCase().includes(s));
  }, [board.data, search]);
  const totals = rows.reduce((t, d) => ({ funded: t.funded + d.funded, gross: t.gross + d.gross, net: t.net + d.net, payout: t.payout + d.totalRepPayout, house: t.house + d.houseNet }), { funded: 0, gross: 0, net: 0, payout: 0, house: 0 });
  const collect = async (id: string, body: Record<string, unknown>, label: string) => {
    try { await post(`/api/admin/deals/${id}/collection`, body); await board.refetch(); notify(label); }
    catch (e) { notify(e instanceof Error ? e.message : 'Could not update'); }
  };
  const setDealStatus = async (id: string, dealStatus: string) => {
    try { await post(`/api/admin/deals/${id}/status`, { dealStatus }, 'PATCH'); await board.refetch(); notify(`${id} — ${dealStatus}`); }
    catch (e) { notify(e instanceof Error ? e.message : 'Could not update'); }
  };

  return (
    <Shell eyebrow="Admin" title="Master deals">
      <Card>
        <div className="toolbar master-toolbar">
          <input className="search master-search" placeholder="Search deal, business, contact, email, phone" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="filter" value={rep} onChange={(e) => setRep(e.target.value)}>
            <option value="">All reps</option>
            {(board.data?.repOptions.edit ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <select className="filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {statusOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
          <span className="count">{rows.length} of {board.data?.count ?? 0} deals</span>
          <button className="btn primary" onClick={() => setCreating(true)} disabled={!settings.data || !board.data}>+ New deal</button>
        </div>
        {!board.data ? <Loading error={board.error} /> : rows.length === 0 ? <Empty>No deals match.</Empty> : (
          <div className="master-table">
            <div className="master-head" style={{ ['--primary-cols' as string]: PRIMARY_COLS }}>
              {['Deal', 'Business / contact', 'Lender / product', 'Funded', 'Net', 'House', 'Date', 'Status', ''].map((h) => <div key={h} className="master-cell">{h}</div>)}
            </div>
            {rows.map((d) => {
              const isExpanded = expanded === d.id;
              const shownStatus = d.storedDealStatus === 'Performing' || d.storedDealStatus === 'Prospecting' || d.storedDealStatus === 'Refi Ready' ? 'Performing' : d.storedDealStatus;
              return (
                <div className={`master-item ${d.atRisk ? 'at-risk' : ''} ${isExpanded ? 'is-open' : ''}`} key={d.id}>
                  <div className="master-primary" style={{ ['--primary-cols' as string]: PRIMARY_COLS }} role="button" tabIndex={0} onClick={() => setOpen(d.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(d.id); } }}>
                    <div className="master-cell deal-key"><b>{d.crmId ?? d.id}</b>{d.crmId && <span className="subtle">#{d.id}</span>}{d.crmUrl && <a href={d.crmUrl} target="_blank" rel="noopener" className="crm-mini" onClick={(e) => e.stopPropagation()} title="Open in CRM">↗</a>}{d.hasClawback && <span className="neg" title="Clawback"> ●</span>}</div>
                    <div className="master-cell business-cell"><b className="ellipsis">{d.business}</b><span className="subtle ellipsis">{d.merchantContact}{d.drawCount > 0 ? ` · ${d.drawCount} draw${d.drawCount > 1 ? 's' : ''}` : ''}</span></div>
                    <div className="master-cell"><b className="ellipsis">{d.lender}</b><span className="subtle ellipsis">{d.product}</span></div>
                    <div className="master-cell num r">{money(d.funded)}</div>
                    <div className="master-cell num r">{money(d.net)}</div>
                    <div className="master-cell num r pos">{money(d.houseNet)}</div>
                    <div className="master-cell num">{day(d.date)}</div>
                    <div className="master-cell"><span className={`pill ${toneFor(d.commissionStatus)}`}>{d.dealStatus}</span><span className="subtle status-sub">{d.commissionStatus}</span></div>
                    <button className="expand-btn" aria-expanded={isExpanded} aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${d.business}`} onClick={(e) => { e.stopPropagation(); setExpanded(isExpanded ? null : d.id); }}>{isExpanded ? '−' : '+'}</button>
                  </div>
                  {isExpanded && (
                    <div className="master-detail">
                      <div><span className="label">Identifiers</span><b className="num">{d.crmId ?? '—'}</b><span className="subtle num">Sheet #{d.id}</span>{d.crmUrl && <a href={d.crmUrl} target="_blank" rel="noopener">Open in CRM ↗</a>}</div>
                      <div className="detail-contact"><span className="label">Merchant contact</span><Contact name={d.merchantContact} email={d.merchantEmail} phone={d.merchantPhone} /></div>
                      <div><span className="label">Lender / product</span><b className="ellipsis">{d.lender}</b><span className="subtle ellipsis">{d.product}</span></div>
                      <div><span className="label">Funded on</span><b className="num">{day(d.date)}</b><span className="subtle num">{d.increments ? (d.increments.stopped ? `Opted out · ${d.increments.total} of ${Math.round(d.increments.planned / d.increments.perIncrement)}` : `${money(d.increments.disbursed)} out · ${d.increments.lenderPaid}/${d.increments.total}`) : 'No draw schedule'}</span></div>
                      <div><span className="label">Factor / APR</span><b className="num">{d.factor !== null ? d.factor.toFixed(2) : d.apr !== null ? `${d.apr}%` : '—'}</b></div>
                      <div><span className="label">Commission</span><b className="num">{pct(d.commRate)}</b></div>
                      <div><span className="label">Gross</span><b className="num">{money(d.gross)}</b></div>
                      <div><span className="label">Referral</span><b className="num">{d.referralFee ? money(d.referralFee) : '—'}</b></div>
                      <div><span className="label">Rep payout</span><b className="num">{money(d.totalRepPayout)}</b></div>
                      {d.roles.map((r) => <div key={r.role}><span className="label">{r.role}</span><b>{r.repId ? r.name : '—'}</b>{r.repId && <span className="subtle num">{pct(r.rate)} · {money(r.amount)}</span>}</div>)}
                      <div className="detail-wide"><span className="label">Collection</span><button className={`pill ${d.overdueReceipts ? 'red' : toneFor(d.lenderPaidLabel === 'Collected' ? 'Paid' : d.commissionStatus)}`} onClick={() => void collect(d.id, { segmentKey: 'base', toggle: true }, `${d.id} — collection updated`)}>{d.lenderPaidLabel}{d.overdueReceipts ? ' · late' : ''}</button>{d.increments && <span className="subtle num"> Lender {d.increments.lenderPaid}/{d.increments.total} · Rep {d.increments.repPaid}/{d.increments.total}</span>}</div>
                      <div className="detail-wide"><span className="label">Commission status</span><select className="mini" value={d.commissionStatus} onChange={(e) => { const next = e.target.value; if (next === 'Partially Paid') { const v = window.prompt(`How much commission has the lender paid so far on ${d.id} ($)?`); if (v === null) return; const dollars = Number(String(v).replace(/[^0-9.]/g, '')); if (!(dollars > 0)) return; void collect(d.id, { segmentKey: 'base', status: next, partialDollars: dollars }, `${d.id} — ${money(dollars)} collected`); return; } void collect(d.id, { segmentKey: 'base', status: next }, `${d.id} — commission ${next.toLowerCase()}`); }}>{['Waiting for payment', 'Partially Paid', 'YES - Paid In Full'].map((s) => <option key={s}>{s}</option>)}</select></div>
                      <div className="detail-wide"><span className="label">Deal status</span><select className="mini" value={shownStatus} title={`Showing ${d.dealStatus}`} onChange={(e) => void setDealStatus(d.id, e.target.value)}>{DEAL_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.value === 'Performing' ? `Auto · ${d.dealStatus}` : o.label}</option>)}</select><div className="clawback-detail">{d.clawbackWindow.cleared ? <span className="cleared"><i>✓</i> {d.clawbackWindow.basis === 'none' ? 'No clawback' : 'Clawback cleared'}</span> : <><ClawbackBar fundedDate={d.date} win={d.clawbackWindow} /><span className="subtle num">clawback · {d.clawbackWindow.daysLeft}d left</span></>}</div></div>
                      <button className="btn detail-open" onClick={() => setOpen(d.id)}>Open deal details</button>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="master-total"><span>{rows.length} opportunities · {rows.reduce((s, d) => s + d.drawCount, 0)} draw lines</span><b className="num">Funded {compact(totals.funded)}</b><b className="num">Net {money(totals.net)}</b><b className="num pos">House {money(totals.house)}</b><b className="num">Payout {money(totals.payout)}</b></div>
          </div>
        )}
        <div className="subtle accounting-note">Rows tinted red are inside the {settings.data?.thresholds.clawbackWindowDays ?? 30}-day clawback window or flagged slow-pay. Deal status follows the dates (Performing → Prospecting at {settings.data?.thresholds.additionalCapitalAfterDays ?? 30} days → Refi Ready at {Math.round((settings.data?.thresholds.renewalMark ?? 0.4) * 100)}% paid in) unless set by hand. Click the lender-paid pill to record a week (weekly lenders) or toggle collected (upfront). The status select writes collection — it never sets a status on its own.</div>
      </Card>
      {open && settings.data && board.data && <AdminDealDrawer id={open} settings={settings.data} editOptions={board.data.repOptions.edit} onClose={() => setOpen(null)} />}
      {creating && settings.data && board.data && <NewDealDrawer settings={settings.data} board={board.data} onClose={() => setCreating(false)} onSaved={(d) => { setCreating(false); setOpen(d.id); }} />}
    </Shell>
  );
}