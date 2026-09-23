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
  deal: unknown; draw: unknown; receipt: unknown;
  payouts: Array<{ repId: string; role: string; amount: number; paidAt: string; alreadyPosted: boolean }>;
  clawback: unknown; problems: string[]; previewToken: string;
}
const statusLabel: Record<Status, string> = {
  not_reviewed: 'Not reviewed', in_progress: 'In progress', needs_attention: 'Needs attention', reviewed: 'Reviewed',
};
const amountInput = (value: number | null) => value === null ? '' : String(value);
const safeDate = (v: string) => v || null;
const defaultPayments = (review: Decision) => review.repPayments ?? [];
const asDecision = (review: Decision): Decision => ({ ...review, repPayments: defaultPayments(review), lenderWeeks: review.lenderWeeks ?? null });

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
    if (rows.length && !selected) setSelected(rows.find((x) => x.status !== 'reviewed')?.sourceId ?? rows[0]!.sourceId);
  }, [rows, selected]);
  useEffect(() => { if (current && !dirty) { setDraft(asDecision(current.review)); setPreview(null); } }, [current?.revision, selected, dirty]);
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
      notify(`${result.sourceId}: ${result.action}`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not commit this import'); }
    finally { setBusy(false); }
  };
  const save = async (status: Status) => {
    if (!current || !draft || busy) return;
    setBusy(true); setError('');
    try {
      await post(`/api/admin/import-review/${encodeURIComponent(current.sourceId)}`, { revision: current.revision, review: draft, status }, 'PATCH');
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['import-reviews'] });
      notify(status === 'reviewed' ? `${current.sourceId} reviewed and saved (not posted to ledger)` : 'Review progress saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save review');
      if ((e as { status?: number }).status === 409) await qc.invalidateQueries({ queryKey: ['import-reviews'] });
    } finally { setBusy(false); }
  };
  const visible = rows.filter((r) => (filter === 'all' || r.status === filter)
    && `${r.sourceId} ${r.source.business} ${r.source.lender}`.toLowerCase().includes(search.toLowerCase()));
  const reviewed = rows.filter((r) => r.status === 'reviewed').length;
  return (
    <div className="import-review">
      <section className="review-intro">
        <div><div className="review-kicker">SAFE IMPORT · STEP 1</div><h3>Review the old tracker, one deal at a time</h3>
          <p>Upload a CSV export of FUNDED DEALS. Reviews save in the database and remain here when you leave or sign in again. Re-uploading unchanged rows keeps their progress; changed rows require a fresh review.</p></div>
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
          {current.alreadyInPortal && <div className="review-caution"><b>Already in portal.</b> This review will not overwrite the existing deal or its ledger. Reconcile it against live data before importing anything.</div>}
          {current.issues.length > 0 && <div className="review-caution"><b>Resolve before marking reviewed</b><ul>{current.issues.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          <div className="review-source">
            <div><span>Funded</span><b>{money(current.source.amount)}</b></div>
            <div><span>Commission rate</span><b>{current.source.commRate ?? '—'}{current.source.commRate && current.source.commRate <= 1 ? ' (fraction)' : '%'}</b></div>
            <div><span>Sheet gross commission</span><b>{current.source.gross === null ? '—' : money(current.source.gross)}</b></div>
            <div><span>Referral fee</span><b>{current.source.referralFee === null ? '—' : money(current.source.referralFee)}</b></div>
            <div><span>Sheet rep payout</span><b>{current.source.totalRepPayout === null ? '—' : money(current.source.totalRepPayout)}</b></div>
          </div>
          <ImportReviewTerms terms={terms} settings={settings.data} roster={(roster.data?.reps ?? []).map((r) => r.name)} onChange={changeTerm} />
           <div className="review-roles"><b>Rep split on sheet</b><span>{current.source.opener || 'No opener'}: {money(current.source.openerDollars ?? 0)}</span><span>{current.source.closer || 'No closer'}: {money(current.source.closerDollars ?? 0)}</span>{current.source.override && <span>{current.source.override}: {money(current.source.overrideDollars ?? 0)}</span>}</div>
          <label className="review-confirm"><input type="checkbox" checked={draft.termsConfirmed} onChange={(e) => change({ termsConfirmed: e.target.checked })} /> I checked the lender, product, funding and commission terms against the source.</label>
          <div className="review-answers">
            <fieldset><legend>Did we receive commission from the lender?</legend><small>Sheet says: {current.source.commissionStatus || 'unknown'} · paid date {current.source.lenderPaid || 'not recorded'}</small>
              <select aria-label="Lender payment answer" value={draft.lender} onChange={(e) => change({ lender: e.target.value as Answer, lenderAmount: null, lenderDate: null })}><option value="unknown">Not sure yet</option><option value="unpaid">No, not received</option><option value="paid">Yes, received</option></select>
              {draft.lender === 'paid' && <div className="review-fields"><label>Amount received <input type="number" min="0.01" step="0.01" value={amountInput(draft.lenderAmount)} onChange={(e) => change({ lenderAmount: e.target.value ? Number(e.target.value) : null })} /></label><label>Actual date <input type="date" value={draft.lenderDate ?? ''} onChange={(e) => change({ lenderDate: safeDate(e.target.value) })} /></label></div>}
            </fieldset>
            <fieldset><legend>Were reps already paid?</legend><small>Sheet rep-paid date: {current.source.repPaid || 'not recorded'}</small>
              <select aria-label="Rep payout answer" value={draft.reps} onChange={(e) => change({ reps: e.target.value as Answer, repAmount: null, repDate: null })}><option value="unknown">Not sure yet</option><option value="unpaid">No, not paid</option><option value="paid">Yes, paid</option></select>
              {draft.reps === 'paid' && <div className="review-fields"><label>Total paid to reps <input type="number" min="0.01" step="0.01" value={amountInput(draft.repAmount)} onChange={(e) => change({ repAmount: e.target.value ? Number(e.target.value) : null })} /></label><label>Actual date <input type="date" value={draft.repDate ?? ''} onChange={(e) => change({ repDate: safeDate(e.target.value) })} /></label></div>}
            </fieldset>
          </div>
           <fieldset className="review-payouts"><legend>Verified historical rep payouts</legend><small>Enter each payout separately. These entries are used for the import and will not be inferred from the sheet total.</small>
             {draft.repPayments.map((payment, index) => <div className="review-payout-row" key={`${index}-${payment.repId}`}>
               <label>Rep <select value={payment.repId} onChange={(e) => { const repPayments = [...draft.repPayments]; repPayments[index] = { ...payment, repId: e.target.value }; change({ repPayments }); }}><option value="">Choose rep</option>{(roster.data?.reps ?? []).map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}</select></label>
               <label>Role <select value={payment.role} onChange={(e) => { const repPayments = [...draft.repPayments]; repPayments[index] = { ...payment, role: e.target.value }; change({ repPayments }); }}><option value="">Choose role</option><option>Opener</option><option>Closer</option><option>Override</option></select></label>
               <label>Amount <input type="number" min="0.01" step="0.01" value={payment.amount || ''} onChange={(e) => { const repPayments = [...draft.repPayments]; repPayments[index] = { ...payment, amount: Number(e.target.value) || 0 }; change({ repPayments }); }} /></label>
               <label>Paid date <input type="date" value={payment.paidAt} onChange={(e) => { const repPayments = [...draft.repPayments]; repPayments[index] = { ...payment, paidAt: e.target.value }; change({ repPayments }); }} /></label>
               <button className="btn subtle" type="button" onClick={() => change({ repPayments: draft.repPayments.filter((_, i) => i !== index) })}>Remove</button>
             </div>)}
             <button className="btn" type="button" onClick={() => change({ repPayments: [...draft.repPayments, { repId: '', role: '', amount: 0, paidAt: '' }] })}>Add rep payout</button>
           </fieldset>
           <label className="review-weeks">Scheduled lender receipt weeks (optional)<input type="number" min="0" step="1" value={draft.lenderWeeks ?? ''} onChange={(e) => change({ lenderWeeks: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} placeholder="Leave blank if unknown" /><small>Use only for a weekly receipt schedule; leave blank when the historical source does not establish one.</small></label>
          <label className="review-notes">Notes / what still needs checking<textarea value={draft.notes} maxLength={2000} rows={3} onChange={(e) => change({ notes: e.target.value })} placeholder="Record any differences or where to verify payment." /></label>
           <div className="review-actions"><button className="btn" disabled={busy} onClick={() => void save(current.issues.length ? 'needs_attention' : 'in_progress')}>Save progress</button><button className="btn primary" disabled={busy || !draft.termsConfirmed || draft.lender === 'unknown' || draft.reps === 'unknown' || current.issues.length > 0} onClick={() => void save('reviewed')}>Mark reviewed</button>{dirty && <span>Unsaved changes — save before preview or commit</span>}</div>
           <section className="review-import-actions"><div><b>Historical import</b><p>Preview is a dry run. Nothing is posted until you explicitly commit the reviewed revision.</p></div><div className="review-actions"><button className="btn" disabled={busy || dirty || current.status !== 'reviewed'} onClick={() => void runPreview()}>Preview import</button><button className="btn primary" disabled={busy || dirty || !preview || preview.sourceId !== current.sourceId || preview.revision !== current.revision || preview.problems.length > 0} onClick={() => void commit()}>Commit preview</button></div>
             {preview && <div className="review-preview"><div className="review-preview-title"><b>Dry-run: {preview.action}</b><span>Revision {preview.revision}</span></div>{preview.problems.length > 0 && <div className="review-caution"><b>Blocked:</b><ul>{preview.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>}<div className="review-preview-grid"><span>Deal <b>{JSON.stringify(preview.deal)}</b></span><span>Draw <b>{JSON.stringify(preview.draw)}</b></span><span>Receipt <b>{JSON.stringify(preview.receipt)}</b></span><span>Clawback <b>{JSON.stringify(preview.clawback)}</b></span></div><h4>Payouts ({preview.payouts.length})</h4><ul className="review-payout-list">{preview.payouts.map((p) => <li key={`${p.repId}-${p.role}-${p.paidAt}`}>{p.repId} · {p.role} · {money(p.amount)} · {p.paidAt} {p.alreadyPosted ? <b className="review-already">Already posted</b> : <b>Will post</b>}</li>)}</ul></div>}
           </section>
           <p className="review-safety">Reviewed means your answers are saved, not that money was posted. Preview is read-only. Commit is explicit and blocked while changes are unsaved or preview problems remain.</p>
        </section>}
      </div>}
    </div>
  );
}