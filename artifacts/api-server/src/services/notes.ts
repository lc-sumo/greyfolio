/**
 * Deal notes (a timestamped history) and deal files (contracts, funding
 * confirmations). Files are stored inline as base64, capped per file, so a
 * launch needs no object store; swap `Repo.insertFile` for S3 later without
 * touching routes.
 */
import { HttpError } from '../http-error.js';
import type { DealFile, DealFileMeta, DealNote, Repo } from '../repo.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/msword', 'application/vnd.ms-excel']);

const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function requireDeal(repo: Repo, dealId: string) {
  const ctx = await repo.loadContext();
  const deal = ctx.deals.find((d) => d.id === dealId);
  if (!deal) throw new HttpError(404, 'Deal not found');
  return deal;
}

export async function addNote(repo: Repo, dealId: string, body: unknown, actorRepId: string): Promise<DealNote> {
  await requireDeal(repo, dealId);
  const text = String(body ?? '').trim();
  if (!text) throw new HttpError(400, 'Write something first');
  if (text.length > 4000) throw new HttpError(400, 'Keep a note under 4,000 characters');
  const note: DealNote = { id: id('note'), dealId, authorRepId: actorRepId, body: text, createdAt: new Date().toISOString() };
  await repo.insertNote(note);
  await repo.writeAudit({ actorRepId, action: 'deal.note', targetRepId: null, path: `/api/admin/deals/${dealId}/notes`, detail: { noteId: note.id, chars: text.length } });
  return note;
}

export async function removeNote(repo: Repo, dealId: string, noteId: string, actorRepId: string): Promise<void> {
  const notes = await repo.listNotes(dealId);
  if (!notes.some((n) => n.id === noteId)) throw new HttpError(404, 'Note not found');
  await repo.deleteNote(noteId);
  await repo.writeAudit({ actorRepId, action: 'deal.note', targetRepId: null, path: `/api/admin/deals/${dealId}/notes/${noteId}`, detail: { deleted: true } });
}

export interface FileUpload {
  name: unknown;
  mime: unknown;
  /** Base64 (no data: prefix). */
  data: unknown;
}

export async function addFile(repo: Repo, dealId: string, upload: FileUpload, actorRepId: string): Promise<DealFileMeta> {
  await requireDeal(repo, dealId);
  const name = String(upload.name ?? '').trim().replace(/[\\/]/g, '_').slice(0, 200);
  const mime = String(upload.mime ?? '').toLowerCase().split(';')[0]!.trim();
  const data = String(upload.data ?? '').replace(/^data:[^,]*,/, '');
  if (!name) throw new HttpError(400, 'The file needs a name');
  if (!ALLOWED_MIME.has(mime)) throw new HttpError(400, `Files of type ${mime || 'unknown'} are not accepted — PDF, images, Word, Excel, CSV or text`);
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw new HttpError(400, 'The upload is not valid base64');
  const size = Math.floor((data.replace(/\s/g, '').length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (size <= 0) throw new HttpError(400, 'The file is empty');
  if (size > MAX_FILE_BYTES) throw new HttpError(400, `Files are capped at ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const file: DealFile = { id: id('file'), dealId, name, mime, size, data: data.replace(/\s/g, ''), uploadedBy: actorRepId, createdAt: new Date().toISOString() };
  await repo.insertFile(file);
  await repo.writeAudit({ actorRepId, action: 'deal.file', targetRepId: null, path: `/api/admin/deals/${dealId}/files`, detail: { fileId: file.id, name, size } });
  const { data: _d, ...meta } = file;
  return meta;
}

export async function fetchFile(repo: Repo, dealId: string, fileId: string): Promise<DealFile> {
  const f = await repo.getFile(fileId);
  if (!f || f.dealId !== dealId) throw new HttpError(404, 'File not found');
  return f;
}

export async function removeFile(repo: Repo, dealId: string, fileId: string, actorRepId: string): Promise<void> {
  await fetchFile(repo, dealId, fileId);
  await repo.deleteFile(fileId);
  await repo.writeAudit({ actorRepId, action: 'deal.file', targetRepId: null, path: `/api/admin/deals/${dealId}/files/${fileId}`, detail: { deleted: true } });
}
