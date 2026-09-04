/** Server-side .xlsx decoding for the importer (node:zlib). The browser demo brings its own inflate. */
import { inflateRawSync } from 'node:zlib';
import { base64ToBytes, readXlsx } from '@greystone/db/seed/xlsx';
import { HttpError } from '../http-error.js';

const inflate = async (b: Uint8Array) => new Uint8Array(inflateRawSync(b));

/**
 * Pick the FUNDED DEALS grid out of an uploaded workbook: the named sheet if
 * given, else the first sheet whose header has "Business Name" and "Lender".
 */
export async function sheetSource(body: { xlsx?: unknown; sheet?: unknown } | undefined): Promise<string[][] | undefined> {
  if (!body || typeof body.xlsx !== 'string' || !body.xlsx) return undefined;
  let wb;
  try {
    wb = await readXlsx(base64ToBytes(body.xlsx), inflate);
  } catch (e) {
    throw new HttpError(400, `Could not read the workbook: ${e instanceof Error ? e.message : String(e)}`);
  }
  const wanted = typeof body.sheet === 'string' ? body.sheet.toLowerCase() : null;
  const looksRight = (grid: string[][]) => grid.some((r) => r.some((c) => c.trim().toLowerCase() === 'business name') && r.some((c) => c.trim().toLowerCase() === 'lender'));
  const sheet = (wanted && wb.sheets.find((s) => s.name.toLowerCase() === wanted)) || wb.sheets.find((s) => /funded/i.test(s.name) && looksRight(s.grid)) || wb.sheets.find((s) => looksRight(s.grid));
  if (!sheet) throw new HttpError(400, `No FUNDED DEALS tab found in the workbook (sheets: ${wb.sheets.map((s) => s.name).join(', ') || 'none'})`);
  return sheet.grid;
}
