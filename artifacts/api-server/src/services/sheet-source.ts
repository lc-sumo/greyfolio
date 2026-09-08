/** Server-side .xlsx decoding for the importer (node:zlib). The browser demo brings its own inflate. */
import { inflateRawSync } from 'node:zlib';
import { base64ToBytes, readXlsx } from '@greystone/db/seed/xlsx';
import { selectFundedDealsSheet } from '@greystone/db/seed/csv';
import { HttpError } from '../http-error.js';

const inflate = async (b: Uint8Array) => new Uint8Array(inflateRawSync(b));

/**
 * Pick the FUNDED DEALS grid out of an uploaded workbook: the named sheet if
 * given, else the first fully-qualified sheet. The selection metadata is
 * returned to the preview so uploads with multiple matching tabs are explicit.
 */
export interface SheetSource {
  grid: string[][];
  sheetName: string;
  matchingSheets: string[];
}

export async function sheetSource(body: { xlsx?: unknown; sheet?: unknown } | undefined): Promise<SheetSource | undefined> {
  if (!body || typeof body.xlsx !== 'string' || !body.xlsx) return undefined;
  let wb;
  try {
    wb = await readXlsx(base64ToBytes(body.xlsx), inflate);
  } catch (e) {
    throw new HttpError(400, `Could not read the workbook: ${e instanceof Error ? e.message : String(e)}`);
  }
  const source = selectFundedDealsSheet(wb.sheets, typeof body.sheet === 'string' ? body.sheet : null);
  if (!source) throw new HttpError(400, `No FUNDED DEALS tab found in the workbook (sheets: ${wb.sheets.map((s) => s.name).join(', ') || 'none'})`);
  return source;
}
