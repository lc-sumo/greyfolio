import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, post, type Settings } from '../lib/api';
import { money } from '../lib/format';
import { useSession } from '../lib/session';
import { ImportReviewTerms } from './ImportReviewTerms';
import type { Answer, Decision, ReviewRow, Source, Status } from './import-review-types';
import './import-review.css';

interface ImportPreview {
  sourceId: string; revision: number; action: string;
  deal: { id: string; business: string; lender: string; product: string; date: string; funded: number; gross: number; net: number } | null;
  draw: { ref: string; amount: number; gross: number } | null;
  receipt: { amount: number; paidAt: string } | null;
  payouts: Array<{ repId: string; role: string; amount: number; paidAt: string; alreadyPosted: boolean }>;
  clawback: { amount: number; date: string } | null; problems: string[]; previewToken: string;
}
const statusLabel: Record<Status, string> = {
  not_reviewed: 'Not reviewed', in_progress: 'In progress', needs_attention: 'Needs attention', reviewed: 'Reviewed', imported: 'In Master Deals',
};
const amountInput = (value: number | null) => value === null ? '' : String(value);
const safeDate = (v: string) => v || null;
const defaultPayments = (review: Decision) => review.repPayments ?? [];
const asDecision = (review: Decision): Decision => ({ ...review, repPayments: defaultPayments(review), lenderWeeks: review.lenderWeeks ?? null });
const sheetPayments = (terms: Source, roster: Array<{ id: string; name: string }>, date: string): Decision['repPayments'] =>
  ([
    [terms.opener, 'Opener', terms.openerDollars],
    [terms.closer, 'Closer', terms.closerDollars],
    [terms.override, 'Override', terms.overrideDollars],
  ] as const).flatMap(([name, role, amount]) => {
    const rep = roster.find((r) => r.name.toLowerCase() === name.toLowerCase());
    return rep && amount !== null && amount > 0 && date ? [{ repId: rep.id, role, amount, paidAt: date }] : [];
  });

export function ImportReviewTab() {
  const { notify } = useSession();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['import-reviews'], queryFn: () => api<{ rows: ReviewRow[] }>('/api/admin/import-review') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  const roster = useQuery({ queryKey: ['roster-reps'], queryFn: () => api<{ reps: Array<{ id: string; name: string }> }>('/api/admin/reps') });
  const rows = query.data?.rows ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Decision | null>(null);
  const [dirty, setDirty] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const current = rows.find((r) => r.sourceId === selected) ?? null;
  const terms = current && draft ? { ...current.source, ...draft.terms } : null;
  useEffect(() => {
    if (rows.length && !selected) setSelected(rows.find((x) => x.status !== 'reviewed' && x.status !== 'imported')?.sourceId ?? rows[0]!.sourceId);
  }, [rows, selected]);
  useEffect(() => {
    if (current && !dirty) {
      setDraft(asDecision(current.review));
      setPreview((p) => p?.sourceId === current.sourceId && p.revision === current.revision ? p : null);
    }
  }, [current?.revision, selected, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const change = (patch: Partial<Decision>) => {
    setDraft((d) => d ? { ...d, ...patch, ...('termsConfirmed' in patch || 'notes' in patch ? {} : { termsConfirmed: false }) } : d);
    setDirty(true); setPreview(null); setError('');
  };
  const changeTerm = <K extends keyof Source>(key: K, value: Source[K]) =>
    change({ terms: { ...draft?.terms, [key]: value } });
  const select = (id: string) => {
    if (dirty && !window.confirm('This deal has unsaved changes. Leave without saving?')) return;
    setDirty(false); setPreview(null); setSelected(id); const next = rows.find((r) => r.sourceId === id)?.review; setDraft(next ? asDecision(next) : null); setError('');
  };
  const stage = async () => {
    if (!file || busy) return;
    if (dirty && !window.confirm('Save your current deal before re-uploading? Unsaved answers will be lost.')) return;
    setBusy(true); setError('');
    try {
      const csv = await file.text();
      const result = await post<{ created: number; unchanged: number; changed: number; total: number }>('/api/admin/import-review/stage', { csv });
       setDirty(false); setDraft(null); setSelected(null); setPreview(null); setFile(null);
      await qc.invalidateQueries({ queryKey: ['import-reviews'] });
      notify(`${result.total} tracker rows staged: ${result.created} new, ${result.unchanged} unchanged, ${result.changed} changed and needing re-review`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not stage the sheet'); }
    finally { setBusy(false); }
  };
  const runPreview = async () => {
    if (!current || !draft || dirty || busy) return;
    setBusy(true); setError('');
    try {
      const result = await post<ImportPreview>(`/api/admin/import-review/${encodeURIComponent(current.sourceId)}/preview`, { revision: current.revision, previewToken: preview?.previewToken ?? null });
      setPreview(result);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not preview this import'); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!current || !preview || preview.sourceId !== current.sourceId || preview.revision !== current.revision || dirty || busy) return;
    if (preview.problems.length || !window.confirm('Commit this preview? This will create the historical deal, receipt, and verified rep payouts.')) return;
    setBusy(true); setError('');
    try {
      const result = await post<{ sourceId: string; action: string }>(`/api/admin/import-review/${encodeURIComponent(current.sourceId)}/commit`, { revision: current.revision, previewToken: preview.previewToken });
      setPreview(null);
      await qc.invalidateQueries({ queryKey: ['import-reviews'] });
      await qc.invalidateQueries();
      notify(`${result.sourceId} added to Master Deals; historical payments reconciled`);
      const index = rows.findIndex((x) => x.sourceId === current.sourceId);
      const next = [...rows.slice(index + 1), ...rows.slice(0, index)].find((x) => x.status !== 'imported' && x.sourceId !== current.sourceId);
      if (next) { setSelected(next.sourceId); setDraft(asDecision(next.review)); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not commit this import'); }
    finally { setBusy(false); }
  };
  const save = async (status: Status) => {
    if (!current || !draft || busy) return;
    setBusy(true); setError('');
    try {
      const saved = await post<{ revision: number }>(`/api/admin/import-review/${encodeURIComponent(current.sourceId)}`, { revision: current.revision, review: draft, status }, 'PATCH');
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['import-reviews'] });
      notify(status === 'reviewed' ? `${current.sourceId} reviewed and saved (not posted to ledger)` : 'Review progress saved');
      if (status === 'reviewed') {
        const result = await post<ImportPreview>(`/api/admin/import-review/${encodeURIComponent(current.sourceId)}/preview`, { revision: saved.revision });
        setPreview(result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save review');
      if ((e as { status?: number }).status === 409) await qc.invalidateQueries({ queryKey: ['import-reviews'] });
    } finally { setBusy(false); }
  };
  const visible = rows.filter((r) => (filter === 'all' || r.status === filter)
    && `${r.sourceId} ${r.source.business} ${r.source.lender}`.toLowerCase().includes(search.toLowerCase()));
  const reviewed = rows.filter((r) => r.status === 'reviewed' || r.status === 'imported').length;
  return (
    <div className="import-review">
      <section className="review-intro">
        <div><div className="review-kicker">SAFE IMPORT · STEP 1</div><h3>Check, preview, add to Master Deals.</h3>
          <p>Sheet values start the review. Correct them, confirm the payment history, then preview exactly what will be added. Your progress is saved between sittings.</p></div>
        <div className="review-progress"><strong>{reviewed} / {rows.length}</strong><span>reviewed</span><div className="review-progress-track"><div style={{ width: `${rows.length ? reviewed / rows.length * 100 : 0}%` }} /></div></div>
      </section>
      <div className="review-upload">
        <label>Current tracker CSV <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <button className="btn primary" disabled={!file || busy} onClick={() => void stage()}>{busy ? 'Saving…' : rows.length ? 'Update staged sheet' : 'Stage for review'}</button>
        <span>Staging never creates deals, lender receipts, or rep payouts.</span>
      </div>
      {error && <div className="review-error" role="alert">{error}</div>}
      {query.isError && <div className="review-error" role="alert">{query.error?.message}</div>}
      {rows.length > 0 && <div className="review-layout">
        <aside className="review-list">
          <div className="review-list-controls">
            <input type="search" aria-label="Find deal" placeholder="Search deal, business or lender" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label="Filter review status" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All deals ({rows.length})</option>{(Object.keys(statusLabel) as Status[]).map((key) => <option key={key} value={key}>{statusLabel[key]} ({rows.filter((x) => x.status === key).length})</option>)}
            </select>
          </div>
          <div className="review-scroll">{visible.map((row) =>
            <button key={row.sourceId} className={`review-list-item ${selected === row.sourceId ? 'active' : ''}`} onClick={() => select(row.sourceId)}>
              <span className="review-list-title"><b>{row.sourceId}</b> {row.source.business}</span>
              <span className="review-list-meta">{row.source.lender} · {row.source.product} · {money(row.source.amount)}</span>
              <span className={`review-state ${row.status}`}>{statusLabel[row.status]}</span>
            </button>)}
            {!visible.length && <p className="review-muted">No deals match this filter.</p>}
          </div>
        </aside>
        {current && draft && terms && <section className="review-detail">
          <div className="review-detail-head"><div><div className="review-kicker">SOURCE ROW {current.source.line} · {current.sourceId}</div><h3>{terms.business}</h3><span className="review-muted">{terms.date} · {terms.lender} · {terms.product}</span></div><span className={`review-state ${current.status}`}>{statusLabel[current.status]}</span></div>
          {current.status === 'imported' ? <div className="review-imported"><b>Added to Master Deals.</b> This row is locked against importing again. Open Master Deals to view the deal.</div> : <>
          {current.alreadyInPortal && <div className="review-caution"><b>Already in portal.</b> The preview checks the live deal and its ledger; it will not overwrite its terms.</div>}
          {current.issues.length > 0 && <div className="review-caution"><b>{dirty ? 'Saved-row issues — save or confirm to check your corrections' : 'Resolve before marking reviewed'}</b><ul>{current.issues.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          <div className="review-source">
            <div><span>Funded</span><b>{money(current.source.amount)}</b></div>
            <div><span>Commission rate</span><b>{current.source.commRate ?? '—'}{current.source.commRate && current.source.commRate <= 1 ? ' (fraction)' : '%'}</b></div>
            <div><span>Sheet gross commission</span><b>{current.source.gross === null ? '—' : money(current.source.gross)}</b></div>
            <div><span>Referral fee</span><b>{current.source.referralFee === null ? '—' : money(current.source.referralFee)}</b></div>
            <div><span>Sheet rep payout</span><b>{current.source.totalRepPayout === null ? '—' : money(current.source.totalRepPayout)}</b></div>
          </div>
          <ImportReviewTerms terms={terms} settings={settings.data} roster={(roster.data?.reps ?? []).map((r) => r.name)} onChange={changeTerm} />
          <div className="review-section-title"><b>Payment history</b><span>Sheet values are suggestions, not live payments. Confirm them against actual records.</span></div>
          <div className="review-answers">
            <fieldset><legend>Did we receive commission from the lender?</legend><small>Sheet says: {current.source.commissionStatus || 'unknown'} · paid date {current.source.lenderPaid || 'not recorded'}</small>
              <select aria-label="Lender payment answer" value={draft.lender} onChange={(e) => change({ lender: e.target.value as Answer, lenderAmount: e.target.value === 'paid' ? terms.gross : null, lenderDate: e.target.value === 'paid' ? current.source.lenderPaid || null : null })}><option value="unknown">Not sure yet</option><option value="unpaid">No, not received</option><option value="paid">Yes, received</option></select>
              {draft.lender === 'paid' && <div className="review-fields"><label>Amount received <input type="number" min="0.01" step="0.01" value={amountInput(draft.lenderAmount)} onChange={(e) => change({ lenderAmount: e.target.value ? Number(e.target.value) : null })} /></label><label>Actual date <input type="date" value={draft.lenderDate ?? ''} onChange={(e) => change({ lenderDate: safeDate(e.target.value) })} /></label></div>}
            </fieldset>
            <fieldset><legend>Were reps already paid?</legend><small>Sheet rep-paid date: {current.source.repPaid || 'not recorded'}</small>
              <label className="review-paid-check"><input type="checkbox" checked={draft.reps === 'paid'} onChange={(e) => change({ reps: e.target.checked ? 'paid' : 'unpaid', repAmount: e.target.checked ? terms.totalRepPayout : null, repDate: e.target.checked ? current.source.repPaid || null : null, repPayments: e.target.checked ? sheetPayments(terms, roster.data?.reps ?? [], current.source.repPaid) : [] })} /> Reps were paid {current.source.repPaid ? '· prechecked from the tracker' : ''}</label>
              {draft.reps === 'paid' && <div className="review-fields"><label>Total paid to reps <input type="number" min="0.01" step="0.01" value={amountInput(draft.repAmount)} onChange={(e) => change({ repAmount: e.target.value ? Number(e.target.value) : null })} /></label><label>Actual date <input type="date" value={draft.repDate ?? ''} onChange={(e) => change({ repDate: safeDate(e.target.value) })} /></label></div>}
            </fieldset>
          </div>
           {draft.reps === 'paid' && <fieldset className="review-payouts"><legend>Who was paid?</legend><small>Each amount and date starts from the tracker when available. Confirm each against your payroll records; these are the payments the import will record.</small>
              {!draft.repPayments.length && <button className="btn" type="button" onClick={() => change({ repPayments: sheetPayments(terms, roster.data?.reps ?? [], draft.repDate ?? current.source.repPaid) })}>Use sheet rep splits as a starting point</button>}
             {draft.repPayments.map((payment, index) => <div className="review-payout-row" key={`${index}-${payment.repId}`}>
               <label>Rep <select value={payment.repId} onChange={(e) => { const repPayments = [...draft.repPayments]; repPayments[index] = { ...payment, repId: e.target.value }; change({ repPayments }); }}><option value="">Choose rep</option>{(roster.data?.reps ?? []).map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}</select></label>
               <label>Role <select value={payment.role} onChange={(e) => { const repPayments = [...draft.repPayments]; repPayments[index] = { ...payment, role: e.target.value }; change({ repPayments }); }}><option value="">Choose role</option><option>Opener</option><option>Closer</option><option>Override</option></select></label>
               <label>Amount <input type="number" min="0.01" step="0.01" value={payment.amount || ''} onChange={(e) => { const repPayments = [...draft.repPayments]; repPayments[index] = { ...payment, amount: Number(e.target.value) || 0 }; change({ repPayments }); }} /></label>
               <label>Paid date <input type="date" value={payment.paidAt} onChange={(e) => { const repPayments = [...draft.repPayments]; repPayments[index] = { ...payment, paidAt: e.target.value }; change({ repPayments }); }} /></label>
               <button className="btn subtle" type="button" onClick={() => change({ repPayments: draft.repPayments.filter((_, i) => i !== index) })}>Remove</button>
             </div>)}
             <button className="btn" type="button" onClick={() => change({ repPayments: [...draft.repPayments, { repId: '', role: '', amount: 0, paidAt: '' }] })}>Add rep payout</button>
            </fieldset>}
           {draft.lender === 'paid' && <details className="review-more"><summary>Scheduled lender receipt weeks (if applicable)</summary><label className="review-weeks">Weeks actually received<input type="number" min="0" step="1" value={draft.lenderWeeks ?? ''} onChange={(e) => change({ lenderWeeks: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} placeholder="Leave blank if not scheduled" /><small>Only for weekly schedules; confirm the week count from actual remittances.</small></label></details>}
          <label className="review-confirm"><input type="checkbox" checked={draft.termsConfirmed} onChange={(e) => change({ termsConfirmed: e.target.checked })} /> I confirmed the corrected deal fields and each payment amount, payee, and date above.</label>
          <details className="review-more"><summary>Optional internal note</summary><label className="review-notes">Only if you want to record something for later<textarea value={draft.notes} maxLength={2000} rows={2} onChange={(e) => change({ notes: e.target.value })} placeholder="Optional — no explanation is required to correct the sheet." /></label></details>
           <div className="review-actions"><button className="btn" disabled={busy} onClick={() => void save(current.issues.length ? 'needs_attention' : 'in_progress')}>Save for later</button><button className="btn primary" disabled={busy || !draft.termsConfirmed || draft.lender === 'unknown' || draft.reps === 'unknown'} onClick={() => void save('reviewed')}>Confirm &amp; preview import</button>{dirty && <span>Unsaved changes — save before import</span>}</div>
           <section className="review-import-actions"><div><b>Historical import</b><p>Preview is a dry run. Nothing is posted until you explicitly commit the reviewed revision.</p></div><div className="review-actions"><button className="btn" disabled={busy || dirty || current.status !== 'reviewed'} onClick={() => void runPreview()}>Preview import</button><button className="btn primary" disabled={busy || dirty || !preview || preview.sourceId !== current.sourceId || preview.revision !== current.revision || preview.problems.length > 0} onClick={() => void commit()}>Commit preview</button></div>
              {preview && <div className="review-preview"><div className="review-preview-title"><b>Dry run: {preview.action === 'new' ? 'Add new deal' : preview.action === 'existing' ? 'Reconcile existing deal' : preview.action === 'draw' ? 'Add draw' : 'Blocked'}</b><span>Review revision {preview.revision}</span></div>{preview.problems.length > 0 && <div className="review-caution"><b>Fix before importing:</b><ul>{preview.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>}<div className="review-preview-grid"><span>Deal <b>{preview.deal ? `${preview.deal.id} · ${preview.deal.business} · ${preview.deal.lender} · ${preview.deal.product}` : 'Not ready'}</b></span><span>Funded <b>{preview.deal ? `${money(preview.deal.funded)} · ${preview.deal.date}` : '—'}</b></span><span>Gross / net commission <b>{preview.deal ? `${money(preview.deal.gross)} / ${money(preview.deal.net)}` : '—'}</b></span><span>Draw <b>{preview.draw ? `${preview.draw.ref} · ${money(preview.draw.amount)} · gross ${money(preview.draw.gross)}` : 'None'}</b></span><span>Lender receipt <b>{preview.receipt ? `${money(preview.receipt.amount)} · ${preview.receipt.paidAt}` : 'None will be posted'}</b></span><span>Clawback <b>{preview.clawback ? `${money(preview.clawback.amount)} · ${preview.clawback.date}` : 'None'}</b></span></div><h4>Historical rep payments ({preview.payouts.length})</h4>{!preview.payouts.length && <p className="review-muted">None will be posted.</p>}<ul className="review-payout-list">{preview.payouts.map((p) => <li key={`${p.repId}-${p.role}-${p.paidAt}`}>{roster.data?.reps.find((r) => r.id === p.repId)?.name ?? p.repId} · {p.role} · {money(p.amount)} · {p.paidAt} {p.alreadyPosted ? <b className="review-already">Already posted</b> : <b>Will post</b>}</li>)}</ul></div>}
           </section>
           <p className="review-safety">Reviewed means your answers are saved, not that money was posted. Preview is read-only. Commit is explicit and blocked while changes are unsaved or preview problems remain.</p>
          </>}
        </section>}
      </div>}
    </div>
  );
}