import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, post, type Settings } from '../lib/api';
import { money } from '../lib/format';
import { useSession } from '../lib/session';
import { ImportReviewTerms } from './ImportReviewTerms';
import type { Answer, Decision, ReviewRow, Source, Status } from './import-review-types';
import './import-review.css';

const statusLabel: Record<Status, string> = {
  not_reviewed: 'Not reviewed', in_progress: 'In progress', needs_attention: 'Needs attention', reviewed: 'Reviewed',
};
const amountInput = (value: number | null) => value === null ? '' : String(value);
const safeDate = (v: string) => v || null;

export function ImportReviewTab() {
  const { notify } = useSession();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['import-reviews'], queryFn: () => api<{ rows: ReviewRow[] }>('/api/admin/import-review') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/admin/settings') });
  const roster = useQuery({ queryKey: ['roster-reps'], queryFn: () => api<{ reps: Array<{ name: string }> }>('/api/admin/reps') });
  const rows = query.data?.rows ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Decision | null>(null);
  const [dirty, setDirty] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [search, setSearch] = useState('');
  const current = rows.find((r) => r.sourceId === selected) ?? null;
  const terms = current && draft ? { ...current.source, ...draft.terms } : null;
  useEffect(() => {
    if (rows.length && !selected) setSelected(rows.find((x) => x.status !== 'reviewed')?.sourceId ?? rows[0]!.sourceId);
  }, [rows, selected]);
  useEffect(() => { if (current && !dirty) setDraft(current.review); }, [current?.revision, selected, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const change = (patch: Partial<Decision>) => {
    setDraft((d) => d ? { ...d, ...patch, ...('termsConfirmed' in patch || 'notes' in patch ? {} : { termsConfirmed: false }) } : d);
    setDirty(true); setError('');
  };
  const changeTerm = <K extends keyof Source>(key: K, value: Source[K]) =>
    change({ terms: { ...draft?.terms, [key]: value } });
  const select = (id: string) => {
    if (dirty && !window.confirm('This deal has unsaved changes. Leave without saving?')) return;
    setDirty(false); setSelected(id); setDraft(rows.find((r) => r.sourceId === id)?.review ?? null); setError('');
  };
  const stage = async () => {
    if (!file || busy) return;
    if (dirty && !window.confirm('Save your current deal before re-uploading? Unsaved answers will be lost.')) return;
    setBusy(true); setError('');
    try {
      const csv = await file.text();
      const result = await post<{ created: number; unchanged: number; changed: number; total: number }>('/api/admin/import-review/stage', { csv });
      setDirty(false); setDraft(null); setSelected(null); setFile(null);
      await qc.invalidateQueries({ queryKey: ['import-reviews'] });
      notify(`${result.total} tracker rows staged: ${result.created} new, ${result.unchanged} unchanged, ${result.changed} changed and needing re-review`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not stage the sheet'); }
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
      if (status === 'reviewed') {
        const index = rows.findIndex((x) => x.sourceId === current.sourceId);
        const next = [...rows.slice(index + 1), ...rows.slice(0, index)].find((x) => x.status !== 'reviewed');
        if (next) { setSelected(next.sourceId); setDraft(next.review); }
      }
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
        <div><div className="review-kicker">SAFE IMPORT · STEP 1</div><h3>Check, correct, confirm. Then move on.</h3>
          <p>The tracker pre-fills the deal and payment answers. Correct anything that is wrong, confirm it, and the next deal opens. Your progress stays saved between sittings.</p></div>
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
          {current.issues.length > 0 && <div className="review-caution"><b>{dirty ? 'Saved-row issues — save or confirm to check corrections' : 'Resolve before marking reviewed'}</b><ul>{current.issues.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          <ImportReviewTerms terms={terms} settings={settings.data} roster={roster.data?.reps.map((r) => r.name) ?? []} onChange={changeTerm} />
          <div className="review-section-title"><b>Payment history</b><span>Pre-filled from the sheet, not recorded as a live payment. Verify before confirming.</span></div>
          <div className="review-answers">
            <fieldset><legend>Did we receive commission from the lender?</legend><small>Sheet says: {current.source.commissionStatus || 'unknown'} · paid date {current.source.lenderPaid || 'not recorded'}</small>
              <select aria-label="Lender payment answer" value={draft.lender} onChange={(e) => change({ lender: e.target.value as Answer, lenderAmount: e.target.value === 'paid' ? terms.gross : null, lenderDate: e.target.value === 'paid' ? current.source.lenderPaid || null : null })}><option value="unknown">Not sure yet</option><option value="unpaid">No, not received</option><option value="paid">Yes, received</option></select>
              {draft.lender === 'paid' && <div className="review-fields"><label>Amount received <input type="number" min="0.01" step="0.01" value={amountInput(draft.lenderAmount)} onChange={(e) => change({ lenderAmount: e.target.value ? Number(e.target.value) : null })} /></label><label>Actual date <input type="date" value={draft.lenderDate ?? ''} onChange={(e) => change({ lenderDate: safeDate(e.target.value) })} /></label></div>}
            </fieldset>
            <fieldset><legend>Were reps already paid?</legend><small>Sheet rep-paid date: {current.source.repPaid || 'not recorded'}</small>
              <label className="review-paid-check"><input type="checkbox" checked={draft.reps === 'paid'} onChange={(e) => change({ reps: e.target.checked ? 'paid' : 'unpaid', repAmount: e.target.checked ? terms.totalRepPayout : null, repDate: e.target.checked ? current.source.repPaid || null : null })} /> Reps were paid {current.source.repPaid ? '· prechecked from the tracker' : ''}</label>
              {draft.reps === 'unknown' && <small>Not sure yet — save progress and return when you know.</small>}
              {draft.reps === 'paid' && <div className="review-fields"><label>Total paid to reps <input type="number" min="0.01" step="0.01" value={amountInput(draft.repAmount)} onChange={(e) => change({ repAmount: e.target.value ? Number(e.target.value) : null })} /></label><label>Actual date <input type="date" value={draft.repDate ?? ''} onChange={(e) => change({ repDate: safeDate(e.target.value) })} /></label></div>}
            </fieldset>
          </div>
          <label className="review-confirm"><input type="checkbox" checked={draft.termsConfirmed} onChange={(e) => change({ termsConfirmed: e.target.checked })} /> I confirmed the corrected deal fields and the payment answers above.</label>
          <details className="review-more"><summary>Optional internal note</summary><label className="review-notes">Only if you want to record something for later<textarea value={draft.notes} maxLength={2000} rows={2} onChange={(e) => change({ notes: e.target.value })} placeholder="Optional — no explanation is required to correct the sheet." /></label></details>
          <div className="review-actions"><button className="btn" disabled={busy} onClick={() => void save(current.issues.length ? 'needs_attention' : 'in_progress')}>Save for later</button><button className="btn primary" disabled={busy || !draft.termsConfirmed || draft.lender === 'unknown' || draft.reps === 'unknown'} onClick={() => void save('reviewed')}>Confirm &amp; next deal</button>{dirty && <span>Unsaved changes</span>}</div>
          <p className="review-safety">Reviewed means your answers are saved, not that money was posted. No staged sheet value can create a lender receipt or payout automatically. Reconcile paid amounts per rep before any live import.</p>
        </section>}
      </div>}
    </div>
  );
}