import { useQuery, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
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

/** Merchant identity can be corrected on any deal, paid or not — optionally across every deal on the same email. */
export function ContactEditor({ deal, onDone, onCancel }: { deal: { id: string; business: string; merchantContact: string; merchantEmail: string; merchantPhone: string }; onDone: (label: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ business: deal.business, merchantContact: deal.merchantContact, merchantEmail: deal.merchantEmail, merchantPhone: deal.merchantPhone });
  const [all, setAll] = useState(!!deal.merchantEmail);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <section className="card">
      <h3>Merchant contact <small>who they are never changes the money, so this works on paid deals too</small></h3>
      <div className="form">
        <div className="split-row">
          <label className="field"><span className="label">Business</span><input value={f.business} onChange={set('business')} autoFocus /></label>
          <label className="field"><span className="label">Contact name</span><input value={f.merchantContact} onChange={set('merchantContact')} /></label>
          <label className="field"><span className="label">Email</span><input type="email" value={f.merchantEmail} onChange={set('merchantEmail')} /></label>
          <label className="field"><span className="label">Phone</span><input value={f.merchantPhone} onChange={set('merchantPhone')} /></label>
        </div>
      </div>
      {deal.merchantEmail && <label className="subtle" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, cursor: 'pointer' }}><input type="checkbox" className="big" checked={all} onChange={(e) => setAll(e.target.checked)} /> Apply to every deal for {deal.merchantEmail}, so the merchant stays one record</label>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !f.business.trim()} onClick={async () => { setBusy(true); setErr(''); try { const r = await post<{ updatedDeals: number }>(`/api/admin/deals/${deal.id}/contact`, { ...f, applyToMerchant: all }, 'PATCH'); onDone(`Contact saved on ${r.updatedDeals} deal${r.updatedDeals === 1 ? '' : 's'}`); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); } }}>Save contact</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="note" style={{ marginTop: 8, background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>{err}</div>}
    </section>
  );
}

/** Correct a draw's amount, date, term, factor or rate. Re-prices; refused once anything was paid on it. */
export function DrawEditor({ dealId, draw, onDone, onCancel }: { dealId: string; draw: { sk: string; label: string; date: string; amount: number; commRate: number; termDays: number | null; factor: number | null }; onDone: (label: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ amount: String(draw.amount), date: draw.date, termDays: draw.termDays === null ? '' : String(draw.termDays), factor: draw.factor === null ? '' : String(draw.factor), commRate: String(Math.round(draw.commRate * 10000) / 100) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <div className="add-draw" style={{ marginTop: 8 }}>
      <div className="form" style={{ gridTemplateColumns: '1.2fr 1fr 1fr 1fr 1fr' }}>
        <label className="field"><span className="label">{draw.label} amount</span><input inputMode="decimal" value={f.amount} onChange={set('amount')} autoFocus /></label>
        <label className="field"><span className="label">Date</span><input type="date" value={f.date} onChange={set('date')} /></label>
        <label className="field"><span className="label">Term (bus. days)</span><input inputMode="numeric" value={f.termDays} onChange={set('termDays')} placeholder="—" /></label>
        <label className="field"><span className="label">Factor</span><input inputMode="decimal" value={f.factor} onChange={set('factor')} placeholder="—" /></label>
        <label className="field"><span className="label">Rate %</span><input inputMode="decimal" value={f.commRate} onChange={set('commRate')} /></label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !(Number(f.amount) > 0)} onClick={async () => { setBusy(true); setErr(''); try { await post(`/api/admin/deals/${dealId}/draws/${draw.sk}`, { amount: Number(f.amount), date: f.date, termDays: f.termDays === '' ? null : Number(f.termDays), factor: f.factor === '' ? null : Number(f.factor), commRate: Number(f.commRate) }, 'PATCH'); onDone(`${dealId} ${draw.sk} re-priced`); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); } }}>Save draw</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="note" style={{ marginTop: 8, background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}

/** A recorded clawback with edit and forgive controls. */
export function ClawbackNote({ dealId, c, onDone }: { dealId: string; c: { id: string; date: string; amount: number; recovered: number; reason: string; status: string; slices: Array<{ repId: string; name: string; share: number; recovered: number; remaining: number }> }; onDone: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ amount: String(c.amount), date: c.date, reason: c.reason });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dateLabel = fullDay(c.date);
  return (
    <div className="note" style={{ background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>
      {editing ? (
        <div className="form" style={{ gridTemplateColumns: '1fr 1fr 2fr auto auto', gap: 8, alignItems: 'end' }}>
          <label className="field"><span className="label">Amount $</span><input inputMode="decimal" value={f.amount} onChange={(e) => setF((s) => ({ ...s, amount: e.target.value }))} /></label>
          <label className="field"><span className="label">Date</span><input type="date" value={f.date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value }))} /></label>
          <label className="field"><span className="label">Reason</span><input value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} /></label>
          <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); setErr(''); try { await post(`/api/admin/deals/${dealId}/clawbacks/${c.id}`, { amount: Number(f.amount), date: f.date, reason: f.reason }, 'PATCH'); setEditing(false); onDone('Clawback updated'); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); } }}>Save</button>
          <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      ) : (
        <>
          Clawback {dateLabel}: <b>{money(c.amount)}</b>{c.reason ? ` — ${c.reason}` : ''}. {c.status === 'open' ? 'Open' : 'Recovered'}: {c.slices.map((s) => `${s.name} ${money(s.remaining)} remaining`).join(', ')}.
          <span style={{ marginLeft: 10, whiteSpace: 'nowrap' }}>
            <button className="linkish" style={{ color: 'var(--red)', fontWeight: 600 }} onClick={() => setEditing(true)}>Edit</button>
            <button className="linkish" style={{ color: 'var(--red)', fontWeight: 600 }} title={c.recovered ? 'Reps have repaid on this — void those recoveries in payroll first' : 'Remove this clawback as recorded in error'} onClick={async () => { if (!window.confirm(`Forgive this ${money(c.amount)} clawback? Every rep slice goes away.`)) return; setErr(''); try { await post(`/api/admin/deals/${dealId}/clawbacks/${c.id}`, {}, 'DELETE'); onDone('Clawback removed'); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not remove'); } }}>Forgive</button>
          </span>
        </>
      )}
      {err && <div style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}
