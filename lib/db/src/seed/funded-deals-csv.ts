/**
 * Reading the tracker's `FUNDED DEALS` tab from a CSV export. Pure parsing:
 * finds the header row by its column names, skips month banners, blank and
 * total rows, and hands back one typed row per deal line.
 */
import { FUNDED_DEALS_COLUMNS } from './funded-deals-columns.js';

/** Minimal RFC 4180 parser: quotes, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export interface SheetRow {
  /** 1-based line in the CSV, for error messages. */
  line: number;
  id: string;
  parent: string;
  date: string;
  business: string;
  lender: string;
  product: string;
  amount: number;
  factor: number | null;
  termDays: number | null;
  frequency: string;
  commRate: number | null;
  psf: number | null;
  referralPartner: string;
  opener: string;
  openerRate: number | null;
  closer: string;
  closerRate: number | null;
  override: string;
  overrideRate: number | null;
  clawbackAmount: number | null;
  clawbackDate: string;
  commissionStatus: string;
  lenderPaid: string;
  repPaid: string;
  dealStatus: string;
  notes: string;
  leadSource: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%$]+/g, ' ').trim();

/** Header text → column letter, tolerant of spacing and case. */
function headerIndex(header: string[]): Map<string, number> {
  const want = new Map(FUNDED_DEALS_COLUMNS.filter((c) => c.header).map((c) => [norm(c.header), c.col]));
  // Later tracker versions renamed a few headers.
  for (const [alias, col] of [['psf %', 'M'], ['psf $', 'N'], ['funded draw amount $', 'G'], ['funded / draw amount $', 'G'], ['term bus days', 'I'], ['comm %', 'L']] as const) if (!want.has(alias)) want.set(alias, col);
  const out = new Map<string, number>();
  header.forEach((h, i) => {
    const col = want.get(norm(h));
    if (col && !out.has(col)) out.set(col, i);
  });
  return out;
}

export function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.replace(/[$,%\s]/g, '');
  if (!t || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** `MM/DD/YYYY`, `YYYY-MM-DD`, `M/D/YY`, or an Excel serial → ISO date; '' when blank or unreadable. */
export function isoDate(v: string | undefined): string {
  const t = (v ?? '').trim();
  if (!t) return '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  }
  if (/^\d{5}$/.test(t)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(t) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export interface SheetRead {
  rows: SheetRow[];
  /** Lines skipped as banners, blanks or totals. */
  skipped: number;
  problems: string[];
}

export function readFundedDealsCsv(text: string): SheetRead {
  const grid = parseCsv(text);
  const headerAt = grid.findIndex((r) => r.some((c) => norm(c) === 'business name') && r.some((c) => norm(c) === 'lender'));
  if (headerAt < 0) return { rows: [], skipped: grid.length, problems: ['Could not find the FUNDED DEALS header row (needs "Business Name" and "Lender" columns)'] };
  const idx = headerIndex(grid[headerAt]!);
  const col = (r: string[], letter: string) => { const i = idx.get(letter); return i === undefined ? undefined : (r[i] ?? '').trim(); };
  const rows: SheetRow[] = [];
  let skipped = 0;
  for (let n = headerAt + 1; n < grid.length; n++) {
    const r = grid[n]!;
    const business = col(r, 'D') ?? '';
    const amount = num(col(r, 'G'));
    const first = (r[0] ?? '').trim();
    if (!business || amount === null || /^▼|^▶|grand tot|^total|total$/i.test(first) || /^▼|^▶/.test(business) || /^\d+ units$/i.test(business)) { skipped++; continue; }
    rows.push({
      line: n + 1,
      id: (col(r, 'A') ?? '').toUpperCase(),
      parent: (col(r, 'B') ?? '').toUpperCase(),
      date: isoDate(col(r, 'C')),
      business,
      lender: col(r, 'E') ?? '',
      product: col(r, 'F') ?? '',
      amount,
      factor: num(col(r, 'H')),
      termDays: num(col(r, 'I')),
      frequency: col(r, 'K') || 'Daily',
      commRate: num(col(r, 'L')),
      psf: num(col(r, 'M')),
      referralPartner: col(r, 'P') ?? '',
      opener: col(r, 'T') ?? '',
      openerRate: num(col(r, 'U')),
      closer: col(r, 'W') ?? '',
      closerRate: num(col(r, 'X')),
      override: col(r, 'Z') ?? '',
      overrideRate: num(col(r, 'AA')),
      clawbackAmount: num(col(r, 'AE')),
      clawbackDate: isoDate(col(r, 'AF')),
      commissionStatus: col(r, 'AM') ?? '',
      lenderPaid: isoDate(col(r, 'AN')),
      repPaid: isoDate(col(r, 'AO')),
      dealStatus: col(r, 'AQ') ?? '',
      notes: col(r, 'AS') ?? '',
      leadSource: col(r, 'AU') ?? '',
    });
  }
  return { rows, skipped, problems: [] };
}
