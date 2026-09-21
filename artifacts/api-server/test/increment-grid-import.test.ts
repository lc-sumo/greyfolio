import { describe, expect, it } from 'vitest';
import { previewIncrementGridUpload } from '../src/services/increment-grid-import.js';

const upload = (text: string, name = 'grid.csv') => ({
  name,
  mime: name.endsWith('.txt') ? 'text/plain' : 'text/csv',
  data: `data:text/csv;base64,${Buffer.from(text).toString('base64')}`,
});

describe('increment grid document preview', () => {
  it('parses quoted CSV headers, currency, and expected dates without mutating anything', async () => {
    const preview = await previewIncrementGridUpload(upload('Funding Date,Disbursement Amount\n"09/01/2026","$12,500.00"\n09/08/2026,"7,500"\n'), 20_000);
    expect(preview.amounts).toEqual([12_500, 7_500]);
    expect(preview.expected).toEqual(['2026-09-01', '2026-09-08']);
    expect(preview.total).toBe(20_000);
    expect(preview.errors).toEqual([]);
  });

  it('reports malformed rows and mismatched totals instead of silently dropping them', async () => {
    const preview = await previewIncrementGridUpload(upload('Amount,Expected Date\n1000,2026-09-01\nbad,2026-09-08\n500,not-a-date\n'), 2_000);
    // A malformed preview is review-only: surviving rows must not populate
    // the deal form or become saveable until every row is corrected.
    expect(preview.amounts).toEqual([]);
    expect(preview.rows).toHaveLength(3);
    expect(preview.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/Row 3.*amount/),
      expect.stringMatching(/Row 4.*expected date/),
      expect.stringMatching(/totals/),
    ]));
  });

  it('rejects unsupported document extraction without pretending to provide OCR', async () => {
    await expect(previewIncrementGridUpload({ name: 'confirmation.pdf', mime: 'application/pdf', data: Buffer.from('x').toString('base64') }, 1)).rejects.toThrow(/CSV, TXT, or XLSX/);
  });
});