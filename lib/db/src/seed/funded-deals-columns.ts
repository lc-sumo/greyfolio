/**
 * `FUNDED DEALS` tab — the 48-column master (row 2 is the header; data
 * starts at row 4). This map is the contract for the Sheets mirror (Phase 8)
 * and for importing the existing tracker.
 *
 *  kind
 *   - input    ops types it in the sheet → a stored portal column
 *   - formula  the sheet computes it → the portal computes the same thing
 *   - derived  portal derives it; pushed to the sheet, never read back
 *   - sheet    sheet-only bookkeeping, not mirrored
 */
export type ColumnKind = 'input' | 'formula' | 'derived' | 'sheet';

export interface FundedDealsColumn {
  col: string;
  header: string;
  /** Portal field (deal column or domain function) this maps to; null when not mirrored. */
  field: string | null;
  kind: ColumnKind;
  note?: string;
}

export const FUNDED_DEALS_HEADER_ROW = 2;
export const FUNDED_DEALS_FIRST_DATA_ROW = 4;

export const FUNDED_DEALS_COLUMNS: readonly FundedDealsColumn[] = [
  { col: 'A', header: 'Deal ID', field: 'id', kind: 'formula', note: '="F"&COUNT($C$4:C4) — the portal issues the same F-series' },
  { col: 'B', header: 'Parent Deal', field: 'opportunityId', kind: 'formula', note: 'Own id for LOC - INITIAL / CONSOLIDATION - UPFRONT COMM / REVERSE - TOTAL FUNDING' },
  { col: 'C', header: 'Date', field: 'date', kind: 'input', note: 'Funded date; never in the future' },
  { col: 'D', header: 'Business Name', field: 'business', kind: 'input' },
  { col: 'E', header: 'Lender', field: 'lender', kind: 'input', note: 'Dropdown SETTINGS!E' },
  { col: 'F', header: 'Product', field: 'product', kind: 'input', note: 'Dropdown SETTINGS!B' },
  { col: 'G', header: 'Funded / Draw Amount ($)', field: 'funded', kind: 'input', note: 'Segment amount — draws mirror as their own rows' },
  { col: 'H', header: 'Factor Rate', field: 'factor', kind: 'input' },
  { col: 'I', header: 'Term (bus. days)', field: 'termDays', kind: 'input' },
  { col: 'J', header: 'Payback ($)', field: 'payback', kind: 'formula', note: 'G×H — paybackOf()' },
  { col: 'K', header: 'Frequency', field: 'frequency', kind: 'input', note: 'Dropdown SETTINGS!C' },
  { col: 'L', header: 'Comm %', field: 'commRate', kind: 'input', note: 'Accepts 12 or 0.12' },
  { col: 'M', header: 'PSF (% or $)', field: 'psfPct', kind: 'input', note: '>100 is read as dollars, >1 as percent, else fraction' },
  { col: 'N', header: 'PSF $ (auto)', field: 'commissionFor().psf', kind: 'formula' },
  { col: 'O', header: 'Gross Commission ($)', field: 'gross', kind: 'formula', note: 'G×L + N' },
  { col: 'P', header: 'Referral Partner', field: 'referralPartner', kind: 'input', note: 'Dropdown PARTNERS!A' },
  { col: 'Q', header: 'Referral %', field: 'referralRate', kind: 'formula', note: 'VLOOKUP PARTNERS' },
  { col: 'R', header: 'Referral Fee ($)', field: 'referralFee', kind: 'formula', note: 'Sheet: (O−N)×Q; portal: gross×rate capped — see review notes' },
  { col: 'S', header: 'Net Comm After Referral ($)', field: 'net', kind: 'formula' },
  { col: 'T', header: 'Opener', field: 'openerId', kind: 'input', note: 'Dropdown REPS!O (active reps)' },
  { col: 'U', header: 'Opener %', field: 'openerRate', kind: 'formula', note: 'VLOOKUP REPS; overridable per deal in the portal' },
  { col: 'V', header: 'Opener $', field: 'commissionFor().openerPayout', kind: 'formula', note: 'Sheet: O×U (gross); portal: net×rate — see review notes' },
  { col: 'W', header: 'Closer', field: 'closerId', kind: 'input' },
  { col: 'X', header: 'Closer %', field: 'closerRate', kind: 'formula' },
  { col: 'Y', header: 'Closer $', field: 'commissionFor().closerPayout', kind: 'formula' },
  { col: 'Z', header: 'Override Rep', field: 'overrideId', kind: 'input' },
  { col: 'AA', header: 'Override %', field: 'overrideRate', kind: 'formula' },
  { col: 'AB', header: 'Override $', field: 'commissionFor().overridePayout', kind: 'formula' },
  { col: 'AC', header: 'Total Rep Payout ($)', field: 'totalRepPayout()', kind: 'formula' },
  { col: 'AD', header: 'HOUSE NET ($)', field: 'houseNet()', kind: 'formula' },
  { col: 'AE', header: 'Clawback $', field: 'clawbacks.amount', kind: 'input', note: 'Deal-level; one clawback record per deal row' },
  { col: 'AF', header: 'Clawback Date', field: 'clawbacks.date', kind: 'input' },
  { col: 'AG', header: 'Opener CB $', field: 'repClawback().share', kind: 'formula' },
  { col: 'AH', header: 'Closer CB $', field: 'repClawback().share', kind: 'formula' },
  { col: 'AI', header: 'Override CB $', field: 'repClawback().share', kind: 'formula' },
  { col: 'AJ', header: 'Rep Clawback $', field: 'clawbackRepTotal()', kind: 'formula' },
  { col: 'AK', header: 'House Clawback $', field: null, kind: 'formula', note: 'AE − AJ' },
  { col: 'AL', header: 'House Net After Clawback ($)', field: null, kind: 'formula', note: 'AD − AK' },
  { col: 'AM', header: 'Commission Status', field: 'dealCommissionStatus()', kind: 'derived', note: 'Sheet dropdown; portal writes it from collection and stages inbound edits' },
  { col: 'AN', header: 'Lender Paid Date', field: 'lenderPaid', kind: 'input' },
  { col: 'AO', header: 'Rep Paid Date', field: 'repPaid', kind: 'derived', note: 'Stamped by the ledger, never typed' },
  { col: 'AP', header: 'Est. Renewal (40% in)', field: null, kind: 'formula', note: 'WORKDAY(C, ROUND(I×renewalMark)) or EDATE for Monthly — Phase 6' },
  { col: 'AQ', header: 'Deal Status', field: 'dealStatus', kind: 'input', note: 'Dropdown SETTINGS!F; sheet auto-flips Refi Ready / Prospecting' },
  { col: 'AR', header: 'Maturity Date', field: null, kind: 'formula', note: 'WORKDAY(C, I) or EDATE — Phase 6' },
  { col: 'AS', header: 'Notes', field: 'notes', kind: 'input' },
  { col: 'AT', header: 'CB Risk', field: null, kind: 'formula', note: '⚠ AT RISK inside clawbackWindowDays of funding' },
  { col: 'AU', header: 'Lead Source', field: 'leadSource', kind: 'input' },
  { col: 'AV', header: '', field: null, kind: 'sheet' },
  { col: 'AW', header: '', field: null, kind: 'sheet', note: 'Running count of rep-paid rows for REP COMMISSION' },
  { col: 'AX', header: '', field: null, kind: 'sheet', note: 'Running count of parent rows for DEAL TRACKER' },
];

/** Column letter for a portal field. */
export function columnFor(field: string): string | undefined {
  return FUNDED_DEALS_COLUMNS.find((c) => c.field === field)?.col;
}

/**
 * The workbook's `PSF (% or $)` cell: >100 is dollars, >1 is a percent, else a fraction.
 * Returns `{ psfRate, psfDollars }` so the caller can decide how to store it.
 */
export function parsePsfCell(v: number | null | undefined): { psfRate: number; psfDollars: number } {
  if (!v || v <= 0) return { psfRate: 0, psfDollars: 0 };
  if (v > 100) return { psfRate: 0, psfDollars: v };
  return { psfRate: v > 1 ? v / 100 : v, psfDollars: 0 };
}

/**
 * Importing the existing tracker: the sheet only has a status, not dollars
 * collected. This is the ONE place status is turned into collection, and it
 * is an import-time approximation (open question #7), never domain logic.
 */
export function collectedFromSheetStatus(status: string | null | undefined, gross: number): number {
  if (status === 'YES - Paid In Full') return gross;
  if (status === 'Partially Paid') return Math.round((gross / 2) * 100) / 100; // assumption: 50%
  return 0;
}
