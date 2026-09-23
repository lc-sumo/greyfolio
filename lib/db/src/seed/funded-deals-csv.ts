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
  /** `PSF $` (column N): typed dollars when the % cell is blank. */
  psfDollars: number | null;
  /** The sheet's own Gross Commission ($) and per-role dollars — when a role's dollars disagree with rate × gross, someone typed an amount by hand. */
  gross: number | null;
  referralFee: number | null;
  totalRepPayout: number | null;
  openerDollars: number | null;
  closerDollars: number | null;
  overrideDollars: number | null;
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
  for (const [alias, col] of [['business', 'D'], ['merchant name', 'D'], ['merchant', 'D'], ['lender name', 'E'], ['product name', 'F'], ['funded draw amount $', 'G'], ['funded / draw amount $', 'G'], ['funded draw amount', 'G'], ['funded / draw amount', 'G'], ['funded amount', 'G'], ['draw amount', 'G'], ['amount', 'G'], ['funded date', 'C'], ['draw date', 'C'], ['psf %', 'M'], ['psf $', 'N'], ['term bus days', 'I'], ['comm %', 'L']] as const) if (!want.has(alias)) want.set(alias, col);
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
  /** Required tracker columns that were not found in the header. */
  missingRequired: string[];
}

/** Required import fields and the Google Sheets export headings we recognize for each. */
export const REQUIRED_FUNDED_DEALS_COLUMNS = [
  { field: 'Business Name', aliases: ['business name', 'business', 'merchant name', 'merchant'] },
  { field: 'Lender', aliases: ['lender', 'lender name'] },
  { field: 'Product', aliases: ['product', 'product name'] },
  { field: 'Funded or Draw Amount', aliases: ['funded draw amount $', 'funded / draw amount $', 'funded draw amount', 'funded / draw amount', 'funded amount', 'draw amount', 'amount'] },
  { field: 'Date', aliases: ['date', 'funded date', 'draw date'] },
] as const;

/** Locate a plausible tracker header and report required columns absent from it. */
export function fundedDealsHeader(grid: string[][]): { at: number; missingRequired: string[] } {
  let best = -1;
  let bestHits = 0;
  for (let n = 0; n < grid.length; n++) {
    const cells = new Set(grid[n]!.map(norm));
    const hits = REQUIRED_FUNDED_DEALS_COLUMNS.filter((required) => required.aliases.some((alias) => cells.has(alias))).length;
    if (hits > bestHits) { best = n; bestHits = hits; }
  }
  // Two known headings distinguishes a header from ordinary tracker text.
  if (bestHits < 2) return { at: -1, missingRequired: REQUIRED_FUNDED_DEALS_COLUMNS.map((x) => x.field) };
  const cells = new Set(grid[best]!.map(norm));
  return { at: best, missingRequired: REQUIRED_FUNDED_DEALS_COLUMNS.filter((required) => !required.aliases.some((alias) => cells.has(alias))).map((x) => x.field) };
}

/** A workbook-shaped sheet, kept dependency-free for both browser demo and server use. */
export interface FundedDealsWorkbookSheet {
  name: string;
  grid: string[][];
}

export interface FundedDealsSheetSelection {
  grid: string[][];
  sheetName: string;
  /** Every sheet with all required columns, in workbook order. */
  matchingSheets: string[];
}

/**
 * Select an import sheet consistently everywhere. A requested existing tab wins
 * (so an operator can intentionally preview its missing columns); otherwise a
 * complete tab wins over an earlier incomplete candidate. If no complete tab
 * exists, retain the best header candidate so validation can explain what to add.
 */
export function selectFundedDealsSheet(sheets: FundedDealsWorkbookSheet[], requestedSheet?: string | null): FundedDealsSheetSelection | undefined {
  const requested = requestedSheet?.trim().toLowerCase();
  const named = requested ? sheets.find((sheet) => sheet.name.toLowerCase() === requested) : undefined;
  const candidates = sheets.filter((sheet) => fundedDealsHeader(sheet.grid).at >= 0);
  const matchingSheets = sheets.filter((sheet) => {
    const header = fundedDealsHeader(sheet.grid);
    return header.at >= 0 && header.missingRequired.length === 0;
  }).map((sheet) => sheet.name);
  const complete = sheets.filter((sheet) => matchingSheets.includes(sheet.name));
  const selected = named ?? complete.find((sheet) => /funded/i.test(sheet.name)) ?? complete[0] ?? candidates[0];
  return selected ? { grid: selected.grid, sheetName: selected.name, matchingSheets } : undefined;
}

export function readFundedDealsCsv(text: string): SheetRead {
  return readFundedDealsTable(parseCsv(text));
}

/** The same reader over an already-parsed grid (CSV or a workbook sheet). */
export function readFundedDealsTable(grid: string[][]): SheetRead {
  const header = fundedDealsHeader(grid);
  const headerAt = header.at;
  if (headerAt < 0) return { rows: [], skipped: grid.length, problems: ['Could not find a FUNDED DEALS header row. Add a header row with Business Name, Lender, Product, Funded or Draw Amount, and Date.'], missingRequired: header.missingRequired };
  const idx = headerIndex(grid[headerAt]!);
  const col = (r: string[], letter: string) => { const i = idx.get(letter); return i === undefined ? undefined : (r[i] ?? '').trim(); };
  const rows: SheetRow[] = [];
  let skipped = 0;
  for (let n = headerAt + 1; n < grid.length; n++) {
    const r = grid[n]!;
    const business = col(r, 'D') ?? '';
    const amount = num(col(r, 'G'));
    const first = (r[0] ?? '').trim();
    // Banners, blanks and totals are intentionally skippable. Every other line is
    // retained, even when a required cell is blank, so preview can block the import.
    // Template rows may have formulas or running counts in the last columns
    // even though every actual deal input is empty. Do not treat those as deals.
    if ((!first && !business && !col(r, 'C') && !col(r, 'E') && !col(r, 'F') && !col(r, 'G'))
      || /^▼|^▶|grand tot|total/i.test(first) || /^▼|^▶/.test(business) || /^\d+ units$/i.test(business)) { skipped++; continue; }
    rows.push({
      line: n + 1,
      id: (col(r, 'A') ?? '').toUpperCase(),
      parent: (col(r, 'B') ?? '').toUpperCase(),
      date: isoDate(col(r, 'C')),
      business,
      lender: col(r, 'E') ?? '',
      product: col(r, 'F') ?? '',
      amount: amount ?? 0,
      factor: num(col(r, 'H')),
      termDays: num(col(r, 'I')),
      frequency: col(r, 'K') || 'Daily',
      commRate: num(col(r, 'L')),
      psf: num(col(r, 'M')),
      psfDollars: num(col(r, 'N')),
      gross: num(col(r, 'O')),
      referralFee: num(col(r, 'R')),
      totalRepPayout: num(col(r, 'AC')),
      openerDollars: num(col(r, 'V')),
      closerDollars: num(col(r, 'Y')),
      overrideDollars: num(col(r, 'AB')),
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
  return { rows, skipped, problems: header.missingRequired.length ? [`Missing required column${header.missingRequired.length === 1 ? '' : 's'}: ${header.missingRequired.join(', ')}. Add ${header.missingRequired.join(', ')} to the header row and preview again.`] : [], missingRequired: header.missingRequired };
}
