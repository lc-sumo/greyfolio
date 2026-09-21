import { inflateRawSync } from 'node:zlib';
import { base64ToBytes, readXlsx } from '@greystone/db/seed/xlsx';
import { HttpError } from '../http-error.js';
import { validateUpload, type FileUpload } from './notes.js';

export interface IncrementGridImportRow {
  row: number;
  amount: number | null;
  expected: string | null;
  error: string | null;
}

export interface IncrementGridPreview {
  source: string;
  amounts: number[];
  expected: Array<string | null>;
  total: number;
  count: number;
  planned: number | null;
  warnings: string[];
  errors: string[];
  rows: IncrementGridImportRow[];
}

const EXTRACT_MIMES = new Set(['text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const AMOUNT_HEADER = /^(amount|funding|funded|disbursement|disbursed|increment|commission amount|principal)( amount| funding| disbursement| disbursed)?$/i;
const DATE_HEADER = /^(date|expected|expected date|funding date|disbursement date|scheduled date)$/i;

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function dateOf(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (() => {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
    if (!m) return null;
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${year.toString().padStart(4, '0')}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  })();
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

function amountOf(value: string): number | null {
  const s = value.trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  const raw = negative ? s.slice(1, -1) : s;
  const n = Number(raw);
  if (!Number.isFinite(n) || negative || n <= 0 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) return null;
  return cents(n);
}

/** Small CSV/TSV reader that preserves malformed fields instead of dropping rows. */
function delimited(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const delimiter = text.split(/\r?\n/, 1)[0]?.includes('\t') ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

function parseRows(grid: string[][], source: string, planned: number | null): IncrementGridPreview {
  const warnings: string[] = [], errors: string[] = [], rows: IncrementGridImportRow[] = [];
  const first = grid.findIndex((r) => r.some((v) => AMOUNT_HEADER.test(v.trim())));
  const hasHeader = first >= 0;
  const start = hasHeader ? first + 1 : 0;
  const headers = hasHeader ? grid[first]!.map((v) => v.trim()) : [];
  const amountIndex = hasHeader ? headers.findIndex((v) => AMOUNT_HEADER.test(v)) : 0;
  const dateIndex = hasHeader ? headers.findIndex((v) => DATE_HEADER.test(v)) : 1;
  if (hasHeader && first > 0) warnings.push(`Ignored ${first} title or preamble row${first === 1 ? '' : 's'}`);
  for (let i = start; i < grid.length; i++) {
    const values = grid[i]!;
    if (!values.some((v) => v.trim())) continue;
    const rawAmount = values[amountIndex] ?? '';
    const amount = amountOf(rawAmount);
    const rawDate = dateIndex >= 0 ? (values[dateIndex] ?? '') : '';
    const expected = rawDate.trim() ? dateOf(rawDate) : null;
    const error = amount === null
      ? `Row ${i + 1}: amount "${rawAmount.trim()}" is missing or not a positive exact-cent value`
      : rawDate.trim() && !expected ? `Row ${i + 1}: expected date "${rawDate.trim()}" is not a valid date` : null;
    if (error) errors.push(error);
    rows.push({ row: i + 1, amount, expected, error });
  }
  const amounts = rows.flatMap((r) => r.amount === null || r.error ? [] : [r.amount]);
  const expected = rows.flatMap((r) => r.amount === null || r.error ? [] : [r.expected]);
  const total = cents(amounts.reduce((sum, n) => sum + n, 0));
  if (!amounts.length && !errors.length) errors.push('No increment amounts were found');
  if (planned !== null && amounts.length && Math.round(total * 100) !== Math.round(planned * 100)) {
    errors.push(`The imported grid totals ${total.toFixed(2)} but the planned funding is ${planned.toFixed(2)}`);
  }
  // A preview with any malformed row is review-only: never let surviving
  // rows populate the deal form or become saveable until the operator fixes
  // the source file and previews it again.
  const usable = errors.length === 0;
  return { source, amounts: usable ? amounts : [], expected: usable ? expected : [], total: usable ? total : 0, count: usable ? amounts.length : 0, planned, warnings, errors, rows };
}

export async function previewIncrementGridUpload(upload: FileUpload, planned: number | null): Promise<IncrementGridPreview> {
  const checked = validateUpload(upload);
  const ext = checked.name.toLowerCase().split('.').pop() ?? '';
  if (!EXTRACT_MIMES.has(checked.mime) && !(ext === 'txt' || ext === 'csv' || ext === 'xlsx')) {
    throw new HttpError(400, 'Grid extraction accepts CSV, TXT, or XLSX files only; attach PDF and image confirmations separately');
  }
  if (ext === 'xls' || checked.mime === 'application/vnd.ms-excel') {
    throw new HttpError(400, 'Legacy XLS files are not supported for extraction; save the workbook as XLSX or CSV first');
  }
  let grid: string[][];
  if (ext === 'xlsx' || checked.mime.includes('spreadsheetml')) {
    try {
      const workbook = await readXlsx(base64ToBytes(checked.data), async (bytes) => new Uint8Array(inflateRawSync(bytes)));
      const sheet = workbook.sheets.find((s) => s.grid.some((r) => r.some((v) => v.trim()))) ?? workbook.sheets[0];
      if (!sheet) throw new Error('The workbook has no readable sheets');
      grid = sheet.grid;
    } catch (e) {
      throw new HttpError(400, `Could not read the XLSX file: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    grid = delimited(new TextDecoder().decode(base64ToBytes(checked.data)));
  }
  return parseRows(grid, checked.name, planned);
}