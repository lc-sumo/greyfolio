import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { AdminDealDrawer } from '../components/AdminDealDrawer';
import { Shell } from '../components/Shell';
import { Card, Contact, Loading, Pill, toneFor } from '../components/ui';
import { DEMO, api, post, type PayResult, type PayableLineView, type PayrollOverview, type PayrollRepDetail, type Settings } from '../lib/api';
import { compact, day, fullDay, initials, money, pct } from '../lib/format';
import { useSession } from '../lib/session';

const COLS = '44px 90px 170px minmax(170px,1.2fr) minmax(170px,1.1fr) 120px 110px 90px 70px 110px minmax(0,1fr)';

export function Payroll() {
  const { notify } = useSession();
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ['payroll'], queryFn: () => api<PayrollOverview>('/api/admin/payroll') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  const [runId, setRunId] = useState<string | null>(null);
  /** Pinned on commit — never re-derived from "whoever is owed most" after a payment. */
  const [repId, setRepId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runs = overview.data?.runs ?? [];
  const reps = overview.data?.reps ?? [];
  const activeRun = runs.find((r) => r.id === runId) ?? runs.find((r) => r.status !== 'paid') ?? runs[0] ?? null;
  const payRepId = repId ?? reps.find((r) => r.owed > 0)?.id ?? reps[0]?.id ?? null;
  useEffect(() => { if (!repId && payRepId) setRepId(payRepId); }, [payRepId, repId]);

  const detail = useQuery({
    queryKey: ['payroll-rep', activeRun?.id, payRepId],
    queryFn: () => api<PayrollRepDetail>(`/api/admin/payroll/runs/${activeRun!.id}/reps/${payRepId}`),
    enabled: !!activeRun && !!payRepId,
  });
  const d = detail.data;
  const q = search.trim().toLowerCase();
  const shown = useMemo(() => (d?.lines ?? []).filter((l) => !q || `${l.dealId} ${l.business} ${l.merchantContact} ${l.merchantEmail} ${l.merchantPhone} ${l.lender}`.toLowerCase().includes(q)), [d, q]);
  // Selection is by ledger unit key. A row's checkbox selects its collected units; the "+ uncollected" toggle adds the rest.
  const amountOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of d?.lines ?? []) {
      for (const k of l.collectedKeys) m.set(k, l.collectedKeys.length ? l.collectedAmount / l.collectedKeys.length : 0);
      for (const k of l.uncollectedKeys) m.set(k, l.uncollectedKeys.length ? l.uncollectedAmount / l.uncollectedKeys.length : 0);
    }
    return m;
  }, [d]);
  const selectedKeys = Object.keys(selected).filter((k) => amountOf.has(k));
  const rowKeys = (l: PayableLineView) => [...l.collectedKeys, ...l.uncollectedKeys];
  const rowSelected = (l: PayableLineView) => rowKeys(l).some((k) => selected[k]);
  const selLines = (d?.lines ?? []).filter(rowSelected);
  const selGross = Math.round(selectedKeys.reduce((s, k) => s + (amountOf.get(k) ?? 0), 0) * 100) / 100;
  const withheld = Math.min(d?.outstandingClawback ?? 0, selGross);
  const uncollected = [...new Set((d?.lines ?? []).filter((l) => l.uncollectedKeys.some((k) => selected[k])).map((l) => l.dealId))];
  const allShown = shown.length > 0 && shown.every((l) => (l.collectedKeys.length ? l.collectedKeys : l.uncollectedKeys).every((k) => selected[k]));
  const toggleRow = (l: PayableLineView) => setSelected((s) => { const n = { ...s }; const keys = l.collectedKeys.length ? l.collectedKeys : l.uncollectedKeys; const on = keys.every((k) => n[k]); for (const k of rowKeys(l)) delete n[k]; if (!on) for (const k of keys) n[k] = true; return n; });
  const toggleUncollected = (l: PayableLineView) => setSelected((s) => { const n = { ...s }; const on = l.uncollectedKeys.every((k) => n[k]); for (const k of l.uncollectedKeys) { if (on) delete n[k]; else n[k] = true; } return n; });
  // Deals are the rows; an LOC's or consolidation's draws sit collapsed under the deal.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const order: string[] = [];
    const by = new Map<string, PayableLineView[]>();
    for (const l of shown) { if (!by.has(l.dealId)) { by.set(l.dealId, []); order.push(l.dealId); } by.get(l.dealId)!.push(l); }
    return order.map((dealId) => ({ dealId, lines: by.get(dealId)! }));
  }, [shown]);
  const defaultKeys = (l: PayableLineView) => (l.collectedKeys.length ? l.collectedKeys : l.uncollectedKeys);
  const groupState = (lines: PayableLineView[]): 'all' | 'some' | 'none' => {
    const on = lines.filter(rowSelected).length;
    return on === 0 ? 'none' : on === lines.length ? 'all' : 'some';
  };
  const toggleGroup = (lines: PayableLineView[]) => setSelected((s) => { const n = { ...s }; const all = lines.every((l) => defaultKeys(l).every((k) => n[k])); for (const l of lines) { for (const k of rowKeys(l)) delete n[k]; if (!all) for (const k of defaultKeys(l)) n[k] = true; } return n; });
  const lineRow = (l: PayableLineView, sub: boolean) => (
    <div className={`tr ${sub ? 'sub' : ''}`} key={l.key} style={{ background: rowSelected(l) ? 'var(--row-selected)' : !l.collected ? 'var(--row-uncollected)' : undefined }}>
      <div className="td pick" onClick={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') toggleRow(l); }} title="Select this line for payout"><input type="checkbox" className="big" checked={rowSelected(l)} onChange={() => toggleRow(l)} /></div>
      <div className="td num" style={{ cursor: 'pointer' }} onClick={() => setOpen(l.dealId)}>{sub ? <span className="subtle">└</span> : l.dealId}</div>
      <div className="td"><span className={l.segmentKey === 'base' ? 'muted' : 'warn'}>{l.segmentLabel}</span>{l.units && <div className="subtle num" style={{ fontSize: 12.5 }}>Lender paid {l.units.collected}/{l.units.total} · Rep paid {l.units.paid}/{l.units.total}</div>}</div>
      <div className="td ellipsis">{sub ? <span className="subtle">{l.business}</span> : l.business}</div>
      <div className="td contact-cell">{sub ? null : <Contact name={l.merchantContact} email={l.merchantEmail} phone={l.merchantPhone} />}</div>
      <div className="td ellipsis">{sub ? null : l.lender}</div>
      <div className="td r num">{compact(l.funded)}</div>
      <div className="td"><Pill tone={l.role === 'Override' ? 'amber' : 'teal'}>{l.role}</Pill></div>
      <div className="td r num">{pct(l.rate)}</div>
      <div className="td r num">{l.units ? <>{money(l.collectedAmount)}<div className="subtle" style={{ fontSize: 12.5 }}>of {money(l.amount)} unpaid</div></> : money(l.amount)}</div>
      <div className="td"><Pill tone={l.collected ? 'teal' : l.lenderPaidLabel === 'Not collected' ? 'grey' : 'amber'}>{l.lenderPaidLabel}</Pill>{l.uncollectedKeys.length > 0 && l.collectedKeys.length > 0 && <label className="subtle" style={{ display: 'block', fontSize: 12.5, marginTop: 3, cursor: 'pointer' }}><input type="checkbox" style={{ verticalAlign: '-2px', marginRight: 4 }} checked={l.uncollectedKeys.every((k) => selected[k])} onChange={() => toggleUncollected(l)} />+ {l.uncollectedKeys.length} uncollected · {money(l.uncollectedAmount)}</label>}</div>
    </div>
  );

  async function pay() {
    if (!activeRun || !payRepId || !selectedKeys.length) { notify('Select at least one deal line to pay'); return; }
    setBusy(true);
    try {
      const r = await post<PayResult>(`/api/admin/payroll/runs/${activeRun.id}/pay`, { repId: payRepId, selectedKeys });
      setRepId(r.repId); // pin
      setSelected({});
      await qc.invalidateQueries();
      notify(`Paid ${money(r.net)} to ${d?.rep.name} across ${r.lines} deal line(s)${r.recoveries ? ` — ${money(r.withheld)} clawback recovered` : ''} — statement updated`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not pay');
    } finally {
      setBusy(false);
    }
  }
  async function advance() {
    if (!activeRun || activeRun.status === 'paid') return;
    try {
      const r = await post<{ status: string; label: string }>(`/api/admin/payroll/runs/${activeRun.id}/advance`, {});
      await qc.invalidateQueries();
      notify(`${r.label} — ${r.status === 'approved' ? 'approved, statements released to reps' : 'marked paid and locked'}`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update run');
    }
  }
  async function newRun() {
    try {
      const r = await post<{ id: string; label: string }>('/api/admin/payroll/runs', {});
      await qc.invalidateQueries();
      setRunId(r.id);
      notify(`${r.label} opened as a draft run`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not open a run');
    }
  }
  async function exportCsv() {
    if (!activeRun) return;
    const path = `/api/admin/payroll/runs/${activeRun.id}/export.csv${payRepId ? `?rep=${payRepId}` : ''}`;
    if (DEMO) { notify('CSV export runs against the real API — the preview has no downloads'); return; }
    window.open(path, '_blank');
  }

  return (
    <Shell eyebrow="Admin" title="Run payroll">
      {!overview.data ? <Loading error={overview.error} /> : (
        <div className="payroll">
          <div className="pay-left">
            <Card title="Runs" extra={settings.data?.payroll.cycle}>
              <div className="runs">
                {runs.map((r) => (
                  <button key={r.id} className={`run ${activeRun?.id === r.id ? 'on' : ''}`} onClick={() => { setRunId(r.id); setSelected({}); }}>
                    <span className="ellipsis"><b>{r.label}</b><span className="subtle">{r.lineCount ? `${compact(r.paidGross)} · ${r.repCount} rep${r.repCount === 1 ? '' : 's'}` : 'nothing paid yet'}</span></span>
                    <Pill tone={toneFor(r.status)}>{r.status === 'paid' ? 'Paid' : r.status === 'approved' ? 'Approved' : 'Draft'}</Pill>
                  </button>
                ))}
              </div>
              <button className="btn" style={{ marginTop: 10, width: '100%' }} onClick={() => void newRun()}>+ Open next run</button>
            </Card>
            <Card title="Reps" extra="sorted by amount owed">
              <div className="runs">
                {reps.map((r) => (
                  <button key={r.id} className={`run ${payRepId === r.id ? 'on' : ''}`} onClick={() => { setRepId(r.id); setSelected({}); }}>
                    <span className="avatar sm">{initials(r.name)}</span>
                    <span className="ellipsis"><b>{r.name}{!r.active && <span className="subtle"> (inactive)</span>}</b><span className="subtle">{r.lineCount ? `${r.lineCount} deal line${r.lineCount === 1 ? '' : 's'}` : 'nothing owed'}</span></span>
                    <span className="num" style={{ color: r.owed ? 'var(--amber)' : 'var(--ink-subtle)' }}>{r.owed ? money(r.owed) : '—'}</span>
                  </button>
                ))}
              </div>
            </Card>
          </div>

          <div className="pay-right">
            {!activeRun ? <Card><div className="empty">No payroll runs yet — open the next run to start.</div></Card> : (
              <>
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div className="label">{activeRun.label}</div>
                      <h2 style={{ margin: '4px 0 0', fontSize: 23, letterSpacing: '-.035em' }}>{d?.rep.name ?? '—'}</h2>
                      <div className="muted">pays {fullDay(activeRun.end)} · {activeRun.status}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn" onClick={() => void exportCsv()}>Export CSV</button>
                      <button className="btn primary" disabled={activeRun.status === 'paid'} onClick={() => void advance()}>{activeRun.status === 'draft' ? 'Approve run' : activeRun.status === 'approved' ? 'Mark as paid' : 'Locked'}</button>
                    </div>
                  </div>
                  <div className="grid-auto" style={{ marginTop: 16 }}>
                    <div><div className="label">Paid in this run</div><div className="metric">{money(activeRun.paidGross)}</div><div className="sub">{activeRun.lineCount} line{activeRun.lineCount === 1 ? '' : 's'} · {activeRun.repCount} rep{activeRun.repCount === 1 ? '' : 's'}</div></div>
                    <div><div className="label">Clawback recovered</div><div className={`metric ${activeRun.recovered ? 'neg' : ''}`}>{money(activeRun.recovered)}</div><div className="sub">netted from payouts</div></div>
                    <div><div className="label">Cash paid</div><div className="metric pos">{money(activeRun.cash)}</div><div className="sub">gross − recovered</div></div>
                    <div><div className="label">Still owed to reps</div><div className="metric warn">{money(overview.data.outstanding)}</div><div className="sub">across every rep</div></div>
                  </div>
                </Card>

                <Card title="Select deals to pay" extra={d ? `${d.lines.length} outstanding line${d.lines.length === 1 ? '' : 's'} for ${d.rep.name}` : ''}>
                  <div className="toolbar" style={{ marginBottom: 12 }}>
                    <input className="search" placeholder="Search deal ID, business, merchant contact, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minWidth: 340 }} />
                    <button className="btn" disabled={!shown.length} onClick={() => setSelected((s) => { const n = { ...s }; shown.forEach((l) => { const keys = l.collectedKeys.length ? l.collectedKeys : l.uncollectedKeys; if (allShown) rowKeys(l).forEach((k) => delete n[k]); else keys.forEach((k) => { n[k] = true; }); }); return n; })}>{allShown ? 'Clear selection' : 'Select all collected'}</button>
                    <span className="count">{selLines.length} of {d?.lines.length ?? 0} lines · {selectedKeys.length} unit{selectedKeys.length === 1 ? '' : 's'}</span>
                  </div>
                  {!d ? <Loading error={detail.error} /> : shown.length === 0 ? (
                    <div className="empty">{d.lines.length === 0 ? `${d.rep.name} has nothing outstanding.` : `No deal lines match “${search}”.`}</div>
                  ) : (
                    <div className="scroller">
                      <div className="table" style={{ ['--cols' as string]: COLS, minWidth: 1260 }}>
                        <div className="tr th"><div className="td">Pay</div><div className="td">Deal</div><div className="td">Line</div><div className="td">Business</div><div className="td">Merchant contact</div><div className="td">Lender</div><div className="td r">Funded</div><div className="td">Role</div><div className="td r">Rate</div><div className="td r">Payout</div><div className="td">Lender paid comm</div></div>
                        {groups.map((g) => {
                          const single = g.lines.length === 1;
                          const l0 = g.lines[0]!;
                          const isOpen = single || !!expanded[g.dealId];
                          const state = groupState(g.lines);
                          const roles = [...new Set(g.lines.map((l) => l.role))];
                          const collectedSegs = g.lines.filter((l) => l.collected).length;
                          return (
                            <Fragment key={g.dealId}>
                              {single ? lineRow(l0, false) : (
                                <div className="tr deal" style={{ background: state === 'all' ? 'var(--row-selected)' : undefined }}>
                                  <div className="td pick" onClick={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') toggleGroup(g.lines); }} title="Select every line on this deal"><input type="checkbox" className="big" ref={(el) => { if (el) el.indeterminate = state === 'some'; }} checked={state === 'all'} onChange={() => toggleGroup(g.lines)} /></div>
                                  <div className="td num" style={{ cursor: 'pointer' }} onClick={() => setOpen(g.dealId)}>{g.dealId}</div>
                                  <div className="td"><button type="button" className="expander" onClick={() => setExpanded((x) => ({ ...x, [g.dealId]: !x[g.dealId] }))} aria-expanded={isOpen}><i>{isOpen ? '▾' : '▸'}</i> {g.lines.length} lines<span className="subtle"> · {g.lines.filter((l) => l.segmentKey !== 'base').length} draw{g.lines.filter((l) => l.segmentKey !== 'base').length === 1 ? '' : 's'}</span></button></div>
                                  <div className="td ellipsis"><b>{l0.business}</b></div>
                                  <div className="td contact-cell"><Contact name={l0.merchantContact} email={l0.merchantEmail} phone={l0.merchantPhone} /></div>
                                  <div className="td ellipsis">{l0.lender}</div>
                                  <div className="td r num">{compact(g.lines.reduce((t, l) => t + l.funded, 0))}</div>
                                  <div className="td">{roles.map((r) => <Pill key={r} tone={r === 'Override' ? 'amber' : 'teal'}>{r}</Pill>)}</div>
                                  <div className="td r num">{[...new Set(g.lines.map((l) => pct(l.rate)))].join('+')}</div>
                                  <div className="td r num">{money(g.lines.reduce((t, l) => t + l.collectedAmount, 0))}{g.lines.some((l) => l.uncollectedAmount > 0) && <div className="subtle" style={{ fontSize: 12.5 }}>of {money(g.lines.reduce((t, l) => t + l.amount, 0))} unpaid</div>}</div>
                                  <div className="td"><Pill tone={collectedSegs === g.lines.length ? 'teal' : collectedSegs ? 'amber' : 'grey'}>{collectedSegs}/{g.lines.length} lines collected</Pill></div>
                                </div>
                              )}
                              {!single && isOpen && g.lines.map((l) => lineRow(l, true))}
                            </Fragment>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="payfoot">
                    <div><span className="label">Selected</span><b>{selLines.length} of {d?.lines.length ?? 0}</b></div>
                    <div><span className="label">Gross</span><b>{money(selGross)}</b></div>
                    <div><span className="label">Clawbacks netted</span><b style={{ color: withheld ? 'var(--red-bright)' : undefined }}>{withheld ? money(-withheld) : '$0'}</b></div>
                    <div><span className="label">Net to pay</span><b style={{ color: 'var(--teal-bright)' }}>{money(selGross - withheld)}</b></div>
                    <button className="btn primary big" disabled={busy || !selLines.length || activeRun.status === 'paid'} onClick={() => void pay()}>{busy ? 'Recording…' : 'Pay selected & record'}</button>
                  </div>
                  {uncollected.length > 0 && <div className="note" style={{ marginTop: 10, background: 'var(--amber-light)', borderColor: 'var(--amber-light-3)', color: 'var(--amber-deep)' }}>{uncollected.length} selected deal line(s) sit on commission the lender has not paid yet ({uncollected.slice(0, 4).join(', ')}{uncollected.length > 4 ? '…' : ''}). Paying now advances the rep against uncollected commission.</div>}
                  {d && d.outstandingClawback > 0 && <div className="note" style={{ marginTop: 10, background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>Outstanding clawback balance for {d.rep.name}: <b>{money(d.outstandingClawback)}</b> across {d.clawbacks.length} deal(s){withheld ? <> — <b>{money(withheld)}</b> recovers on this payout, leaving {money(d.outstandingClawback - withheld)}.</> : '. It nets against the next payout that has gross to withhold from.'}</div>}
                </Card>

                <Card title="Paid in this run" extra={d && d.paidInRun.length ? `${d.paidSummary.lineCount} deal line(s) · cash ${money(d.paidSummary.cash)}` : ''}>
                  {!d || d.paidInRun.length === 0 ? <div className="muted">Nothing recorded for {d?.rep.name ?? 'this rep'} in {activeRun.label} yet.</div> : (
                    <>
                      <div className="scroller">
                        <div className="table" style={{ ['--cols' as string]: '90px minmax(170px,1.2fr) minmax(150px,1fr) 170px 120px minmax(0,1fr)', minWidth: 800 }}>
                          <div className="tr th"><div className="td">Deal</div><div className="td">Business</div><div className="td">Merchant</div><div className="td">Role</div><div className="td r">Amount</div><div className="td">Date</div></div>
                          {d.paidInRun.map((p) => (
                            <div className="tr" key={p.key}>
                              <div className="td num" style={{ cursor: 'pointer' }} onClick={() => setOpen(p.dealId)}>{p.dealId}</div>
                              <div className="td ellipsis">{p.business}</div>
                              <div className="td contact-cell"><Contact name={p.merchantContact} email={p.merchantEmail} phone={p.merchantPhone} /></div>
                              <div className={`td ${p.amount < 0 ? 'neg' : ''}`}>{p.role}{p.segmentKey && p.segmentKey !== 'base' ? ` · ${p.segmentKey}` : ''}{p.unitLabel ? <span className="subtle"> · {p.unitLabel}</span> : ''}</div>
                              <div className={`td r num ${p.amount < 0 ? 'neg' : 'pos'}`}>{money(p.amount)}</div>
                              <div className="td num">{day(p.paidAt)}</div>
                            </div>
                          ))}
                          <div className="tr total"><div className="td" style={{ gridColumn: '1 / 5' }}>Gross {money(d.paidSummary.gross)}{d.paidSummary.recovered ? ` − clawback recovered ${money(d.paidSummary.recovered)}` : ''} = cash paid {money(d.paidSummary.cash)}</div><div className="td r num">{money(d.paidSummary.cash)}</div><div className="td" /></div>
                        </div>
                      </div>
                    </>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>
      )}
      {open && settings.data && <AdminDealDrawer id={open} settings={settings.data} editOptions={[]} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
