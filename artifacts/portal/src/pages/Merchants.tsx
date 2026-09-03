import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { AdminDealDrawer } from '../components/AdminDealDrawer';
import { Shell } from '../components/Shell';
import { Card, Contact, Empty, Loading, Pill, toneFor } from '../components/ui';
import { api, type MerchantRow, type Settings } from '../lib/api';
import { compact, day, money } from '../lib/format';

/** Everything groups on merchant email. */
export function Merchants() {
  const q = useQuery({ queryKey: ['merchants'], queryFn: () => api<{ merchants: MerchantRow[] }>('/api/admin/merchants') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.merchants ?? []).filter((m) => !s || `${m.email} ${m.business} ${m.contact} ${m.phone} ${m.deals.map((d) => `${d.id} ${d.crmId ?? ''} ${d.business}`).join(' ')}`.toLowerCase().includes(s));
  }, [q.data, search]);
  const totals = rows.reduce((t, m) => ({ deals: t.deals + m.dealCount, funded: t.funded + m.funded, gross: t.gross + m.gross, outstanding: t.outstanding + m.outstanding }), { deals: 0, funded: 0, gross: 0, outstanding: 0 });

  return (
    <Shell eyebrow="Admin" title="Merchants">
      <div className="grid-auto">
        <section className="card"><div className="label">Merchants</div><div className="metric">{rows.length}</div><div className="sub">grouped by merchant email</div></section>
        <section className="card"><div className="label">Deals</div><div className="metric">{totals.deals}</div><div className="sub">{(totals.deals / Math.max(1, rows.length)).toFixed(1)} per merchant</div></section>
        <section className="card"><div className="label">Funded</div><div className="metric">{compact(totals.funded)}</div></section>
        <section className="card"><div className="label">Gross commission</div><div className="metric">{compact(totals.gross)}</div><div className="sub warn">{money(totals.outstanding)} outstanding from lenders</div></section>
      </div>
      <Card>
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <input className="search" placeholder="Search email, business, contact, phone or deal ID" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 340 }} />
          <span className="count">{rows.length} merchant{rows.length === 1 ? '' : 's'}</span>
        </div>
        {!q.data ? <Loading error={q.error} /> : rows.length === 0 ? <Empty>No merchants match.</Empty> : (
          <div className="merchants">
            {rows.map((m) => {
              const key = m.email || `business:${m.business}`;
              const isOpen = expanded === key;
              return (
                <div key={key} className={`merchant ${isOpen ? 'open' : ''}`}>
                  <button className="merchant-row" onClick={() => setExpanded(isOpen ? null : key)}>
                    <span className="who"><b>{m.business}</b><Contact name={m.contact} email={m.email || null} phone={m.phone} />{!m.email && <span className="subtle">no email on file</span>}</span>
                    <span className="stat"><span className="label">Deals</span><b className="num">{m.dealCount}</b></span>
                    <span className="stat"><span className="label">Funded</span><b className="num">{compact(m.funded)}</b></span>
                    <span className="stat"><span className="label">Gross commission</span><b className="num">{compact(m.gross)}</b></span>
                    <span className="stat"><span className="label">Outstanding</span><b className={`num ${m.outstanding ? 'warn' : 'pos'}`}>{money(m.outstanding)}</b></span>
                    <span className="stat"><span className="label">Since</span><b className="num">{day(m.firstFunded)}</b></span>
                    <span className="chev">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  {isOpen && (
                    <div className="scroller" style={{ margin: '0 0 6px', padding: '0 12px 12px' }}>
                      <div className="table" style={{ ['--cols' as string]: '120px 70px 90px minmax(170px,1.2fr) 130px minmax(150px,1fr) 110px 110px 110px 150px minmax(0,1fr)', minWidth: 1320 }}>
                        <div className="tr th"><div className="td">Deal ID</div><div className="td">Sheet #</div><div className="td">Date</div><div className="td">Business</div><div className="td">Lender</div><div className="td">Product</div><div className="td r">Funded</div><div className="td r">Gross</div><div className="td r">Outstanding</div><div className="td">Commission</div><div className="td">Deal status</div></div>
                        {m.deals.map((d) => (
                          <div className="tr click" key={d.id} onClick={() => setOpen(d.id)}>
                            <div className="td num">{d.crmId ?? <span className="subtle">—</span>}{d.crmUrl && <a href={d.crmUrl} target="_blank" rel="noopener" className="crm-mini" onClick={(e) => e.stopPropagation()}>↗</a>}</div>
                            <div className="td num subtle">{d.id}</div>
                            <div className="td num">{day(d.date)}</div>
                            <div className="td ellipsis">{d.business}{d.drawCount > 0 && <span className="subtle"> · {d.drawCount} draw{d.drawCount > 1 ? 's' : ''}</span>}</div>
                            <div className="td ellipsis">{d.lender}</div>
                            <div className="td ellipsis">{d.product}</div>
                            <div className="td r num">{money(d.funded)}</div>
                            <div className="td r num">{money(d.gross)}</div>
                            <div className={`td r num ${d.outstanding ? 'warn' : ''}`}>{money(d.outstanding)}</div>
                            <div className="td"><Pill tone={toneFor(d.commissionStatus)}>{d.commissionStatus}</Pill></div>
                            <div className="td"><Pill tone={toneFor(d.dealStatus)}>{d.dealStatus}</Pill></div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {open && settings.data && <AdminDealDrawer id={open} settings={settings.data} editOptions={[]} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
