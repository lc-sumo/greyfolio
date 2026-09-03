import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, post, type DealFileView, type DealNoteView } from '../lib/api';
import { fullDay, money } from '../lib/format';
import { useSession } from '../lib/session';

/** Admin drawer add-ons: record a clawback, keep a note history, attach files. */
export function RecordClawback({ dealId, gross, onDone }: { dealId: string; gross: number; onDone: (label: string) => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <button className="btn" style={{ color: 'var(--red)' }} onClick={() => setOpen(true)} title="The lender clawed back commission — each rep's slice nets against their next payout">Record clawback</button>;
  return (
    <section className="card" style={{ borderColor: 'var(--red-light-2)' }}>
      <h3>Record a clawback <small>on gross commission of {money(gross)}; reps repay pro-rata, once</small></h3>
      <div className="form">
        <div className="split-row">
          <label className="field"><span className="label">Amount clawed back $</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
          <label className="field"><span className="label">Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field"><span className="label">Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Merchant defaulted inside the window" /></label>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !(Number(amount) > 0)} onClick={async () => { setBusy(true); setErr(''); try { const r = await post<{ notified: number }>(`/api/admin/deals/${dealId}/clawbacks`, { amount: Number(amount), date, reason }); setOpen(false); setAmount(''); setReason(''); onDone(`Clawback recorded on ${dealId}${r.notified ? ` — ${r.notified} rep${r.notified === 1 ? '' : 's'} emailed` : ''}`); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not record'); } finally { setBusy(false); } }}>Record</button>
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {err && <div className="note" style={{ marginTop: 8, background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>{err}</div>}
    </section>
  );
}

export function DealNotes({ dealId }: { dealId: string }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deal-notes', dealId], queryFn: () => api<{ notes: DealNoteView[] }>(`/api/admin/deals/${encodeURIComponent(dealId)}/notes`) });
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const notes = q.data?.notes ?? [];
  async function add() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await post(`/api/admin/deals/${dealId}/notes`, { body });
      setBody('');
      await qc.invalidateQueries({ queryKey: ['deal-notes', dealId] });
      notify('Note added');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not add the note');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h3>Notes <small>{notes.length ? `${notes.length} · newest first` : 'a running history — nothing gets overwritten'}</small></h3>
      <div className="noteadd">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Called the merchant, wire promised Friday…" rows={2} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void add(); }} />
        <button className="btn primary" disabled={busy || !body.trim()} onClick={() => void add()}>Add note</button>
      </div>
      {notes.length > 0 && (
        <div className="notelist">
          {notes.map((n) => (
            <div className="noteitem" key={n.id}>
              <div className="meta"><b>{n.author}</b> · {fullDay(n.createdAt.slice(0, 10))} {n.createdAt.slice(11, 16)}
                <button className="linkish" style={{ color: 'var(--ink-subtle)', marginLeft: 8 }} title="Delete this note" onClick={async () => { if (!window.confirm('Delete this note?')) return; await post(`/api/admin/deals/${dealId}/notes/${n.id}`, {}, 'DELETE'); await qc.invalidateQueries({ queryKey: ['deal-notes', dealId] }); }}>✕</button>
              </div>
              <div className="body">{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export function DealFiles({ dealId }: { dealId: string }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deal-files', dealId], queryFn: () => api<{ files: DealFileView[] }>(`/api/admin/deals/${encodeURIComponent(dealId)}/files`) });
  const [busy, setBusy] = useState(false);
  const files = q.data?.files ?? [];
  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      for (const f of Array.from(list)) {
        if (f.size > 5 * 1024 * 1024) throw new Error(`${f.name} is over 5 MB`);
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error(`Could not read ${f.name}`));
          r.readAsDataURL(f);
        });
        await post(`/api/admin/deals/${dealId}/files`, { name: f.name, mime: f.type || 'application/octet-stream', data });
      }
      await qc.invalidateQueries({ queryKey: ['deal-files', dealId] });
      notify(list.length === 1 ? `${list[0]!.name} attached` : `${list.length} files attached`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h3>Files <small>contracts, funding confirmations · PDF, images, Word, Excel · 5 MB each</small></h3>
      <label className={`dropzone${busy ? ' busy' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
        <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.doc,.docx,.xls,.xlsx" style={{ display: 'none' }} onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
        {busy ? 'Uploading…' : 'Drop files here or click to choose'}
      </label>
      {files.length > 0 && (
        <div className="filelist">
          {files.map((f) => (
            <div className="fileitem" key={f.id}>
              <a href={`/api/admin/deals/${encodeURIComponent(dealId)}/files/${f.id}`} target="_blank" rel="noopener">{f.name}</a>
              <span className="subtle">{fmtSize(f.size)} · {f.uploadedByName} · {fullDay(f.createdAt.slice(0, 10))}</span>
              <button className="linkish" style={{ color: 'var(--ink-subtle)' }} title="Delete this file" onClick={async () => { if (!window.confirm(`Delete ${f.name}?`)) return; await post(`/api/admin/deals/${dealId}/files/${f.id}`, {}, 'DELETE'); await qc.invalidateQueries({ queryKey: ['deal-files', dealId] }); }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
