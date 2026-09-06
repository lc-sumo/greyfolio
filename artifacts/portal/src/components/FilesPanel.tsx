import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DEMO, api, post, type RepFileView } from '../lib/api';
import { fullDay } from '../lib/format';
import { useSession } from '../lib/session';

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Files on a rep: W-9, agreements. `base` is the API prefix that lists,
 * uploads and downloads them (/api/admin/reps/:id/files or /api/me/files).
 */
export function FilesPanel({ base, title = 'Files', hint = 'W-9, agreements · PDF, images, Word, Excel · 5 MB each', canDelete = true, canUpload = true }: { base: string; title?: string; hint?: string; canDelete?: boolean; canUpload?: boolean }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const key = ['files', base];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ files: RepFileView[] }>(base) });
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
        await post(base, { name: f.name, mime: f.type || 'application/octet-stream', data });
      }
      await qc.invalidateQueries({ queryKey: key });
      notify(list.length === 1 ? `${list[0]!.name} added` : `${list.length} files added`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h3>{title} <small>{hint}</small></h3>
      {canUpload && (
        <label className={`dropzone${busy ? ' busy' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
          <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.doc,.docx,.xls,.xlsx" style={{ display: 'none' }} onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
          {busy ? 'Uploading…' : 'Drop files here or click to choose'}
        </label>
      )}
      {files.length === 0 ? <div className="subtle" style={{ fontSize: 13, marginTop: 8 }}>Nothing on file yet.</div> : (
        <div className="filelist">
          {files.map((f) => (
            <div className="fileitem" key={f.id}>
              {DEMO ? <span>{f.name}</span> : <a href={`${base}/${f.id}`} target="_blank" rel="noopener">{f.name}</a>}
              <span className="subtle">{fmtSize(f.size)}{f.uploadedByName ? ` · ${f.uploadedByName}` : ''} · {fullDay(f.createdAt.slice(0, 10))}</span>
              {canDelete && <button className="linkish" style={{ color: 'var(--ink-subtle)' }} title="Delete this file" onClick={async () => { if (!window.confirm(`Delete ${f.name}?`)) return; await post(`${base}/${f.id}`, {}, 'DELETE'); await qc.invalidateQueries({ queryKey: key }); }}>✕</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
