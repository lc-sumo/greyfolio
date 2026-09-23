import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, post } from '../lib/api';
import { money } from '../lib/format';
import { useSession } from '../lib/session';
import './import-review.css';

type Answer = 'unknown' | 'unpaid' | 'paid';
type Status = 'not_reviewed' | 'in_progress' | 'needs_attention' | 'reviewed';
interface Decision {
  termsConfirmed: boolean;
  lender: Answer; lenderAmount: number | null; lenderDate: string | null;
  reps: Answer; repAmount: number | null; repDate: string | null; notes: string;
}
interface Source {
  line: number; id: string; parent: string; date: string; business: string; lender: string; product: string;
  amount: number; gross: number | null; referralFee: number | null; totalRepPayout: number | null; commRate: number | null;
  opener: string; closer: string; override: string; openerDollars: number | null; closerDollars: number | null; overrideDollars: number | null;
  lenderPaid: string; repPaid: string; commissionStatus: string; notes: string;
}
interface ReviewRow {
  sourceId: string; sourceHash: string; source: Source; review: Decision; status: Status; revision: number;
  issues: string[]; alreadyInPortal: boolean; updatedAt: string;
}
const statusLabel: Record<Status, string> = {
  not_reviewed: 'Not reviewed', in_progress: 'In progress', needs_attention: 'Needs attention', reviewed: 'Reviewed',
};
const amountInput = (value: number | null) => value === null ? '' : String(value);
const safeDate = (v: string) => v || null;

export function ImportReviewTab() {
  const { notify } = useSession();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['import-reviews'], queryFn: () => api<{ rows: ReviewRow[] }>('/api/admin/import-review') });
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
  const change = (patch: Partial<Decision>) => { setDraft((d) => d ? { ...d, ...patch } : d); setDirty(true); setError(''); };
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
        {current && draft && <section className="review-detail">
          <div className="review-detail-head"><div><div className="review-kicker">SOURCE ROW {current.source.line} · {current.sourceId}</div><h3>{current.source.business}</h3><span className="review-muted">{current.source.date} · {current.source.lender} · {current.source.product}</span></div><span className={`review-state ${current.status}`}>{statusLabel[current.status]}</span></div>
          {current.alreadyInPortal && <div className="review-caution"><b>Already in portal.</b> This review will not overwrite the existing deal or its ledger. Reconcile it against live data before importing anything.</div>}
          {current.issues.length > 0 && <div className="review-caution"><b>Resolve before marking reviewed</b><ul>{current.issues.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          <div className="review-source">
            <div><span>Funded</span><b>{money(current.source.amount)}</b></div>
            <div><span>Commission rate</span><b>{current.source.commRate ?? '—'}{current.source.commRate && current.source.commRate <= 1 ? ' (fraction)' : '%'}</b></div>
            <div><span>Sheet gross commission</span><b>{current.source.gross === null ? '—' : money(current.source.gross)}</b></div>
            <div><span>Referral fee</span><b>{current.source.referralFee === null ? '—' : money(current.source.referralFee)}</b></div>
            <div><span>Sheet rep payout</span><b>{current.source.totalRepPayout === null ? '—' : money(current.source.totalRepPayout)}</b></div>
          </div>
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
          <label className="review-notes">Notes / what still needs checking<textarea value={draft.notes} maxLength={2000} rows={3} onChange={(e) => change({ notes: e.target.value })} placeholder="Record any differences or where to verify payment." /></label>
          <div className="review-actions"><button className="btn" disabled={busy} onClick={() => void save(current.issues.length ? 'needs_attention' : 'in_progress')}>Save progress</button><button className="btn primary" disabled={busy || !draft.termsConfirmed || draft.lender === 'unknown' || draft.reps === 'unknown' || current.issues.length > 0} onClick={() => void save('reviewed')}>Mark reviewed</button>{dirty && <span>Unsaved changes</span>}</div>
          <p className="review-safety">Reviewed means your answers are saved, not that money was posted. No staged sheet value can create a lender receipt or payout automatically. Reconcile paid amounts per rep before any live import.</p>
        </section>}
      </div>}
    </div>
  );
}