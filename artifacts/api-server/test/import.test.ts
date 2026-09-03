import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryRepo } from './memory-repo.js';

const config = configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'test-secret', PORT: '0' });
async function harness() {
  const repo = memoryRepo();
  const app = createApp(config, repo);
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  return { repo, admin };
}

const HEADER = 'Deal ID,Parent Deal,Date,Business Name,Lender,Product,Funded / Draw Amount ($),Factor Rate,Term (bus. days),Payback ($),Frequency,Comm %,PSF (% or $),PSF $ (auto),Gross Commission ($),Referral Partner,Referral %,Referral Fee ($),Net Comm After Referral ($),Opener,Opener %,Opener $,Closer,Closer %,Closer $,Override Rep,Override %,Override $,Total Rep Payout ($),HOUSE NET ($),Clawback $,Clawback Date,Opener CB $,Closer CB $,Override CB $,Rep Clawback $,House Clawback $,House Net After Clawback ($),Commission Status,Lender Paid Date,Rep Paid Date,Est. Renewal (40% in),Deal Status,Maturity Date,Notes,CB Risk,Lead Source';
/** Build a 48-column row by column letter, so the test does not count commas. */
function row(cells: Record<string, string>): string {
  const letters = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','AA','AB','AC','AD','AE','AF','AG','AH','AI','AJ','AK','AL','AM','AN','AO','AP','AQ','AR','AS','AT','AU','AV'];
  return letters.map((l) => { const v = cells[l] ?? ''; return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',');
}
const csv = [
  '2026 GRAND TOTAL,,,0 units,,,0',
  HEADER,
  '▼  APRIL 2026',
  row({ A: 'F10', B: 'F10', C: '4/6/2026', D: 'Harbor Street, LLC', E: 'MBC', F: 'MCA', G: '100000', H: '1.3', I: '120', K: 'Daily', L: '12', M: '2', P: 'MBC', T: 'Julian Ribak', U: '35', W: 'Zach Sanders', X: '40', Z: 'Raymond Amato', AA: '5', AM: 'YES - Paid In Full', AN: '4/20/2026', AO: '5/1/2026', AQ: 'Performing', AS: 'Imported note', AU: 'Referral' }),
  row({ A: 'F11', B: 'F11', C: '4/8/2026', D: 'Ridge Plumbing', E: 'Revenued', F: 'LOC - INITIAL', G: '50000', I: '90', K: 'Weekly', L: '8', M: '0', P: 'None', T: 'Julian Ribak', U: '35', AM: 'Partially Paid', AQ: 'Performing', AU: 'Direct' }),
  row({ A: 'F12', B: 'F11', C: '4/22/2026', D: 'Ridge Plumbing', E: 'Revenued', F: 'LOC DRAW', G: '20000', K: 'Weekly', L: '4', M: '0', P: 'None', T: 'Julian Ribak', U: '35', AM: 'Waiting for payment', AQ: 'Performing' }),
  row({ C: '5/2/2026', D: 'No Id Co', E: 'Forward', F: 'MCA', G: '30000', H: '1.35', I: '180', K: 'Monthly', L: '10', M: '0', P: 'None', T: 'Zach Sanders', U: '40', AE: '2500', AF: '5/20/2026', AM: 'Waiting for payment', AQ: 'Default' }),
  'APRIL TOTAL,,,4 units,,,200000',
].join('\r\n');

describe('sheet import', () => {
  it('previews every row with its problems, then commits deals, draws, clawbacks and paid history', async () => {
    const { admin } = await harness();
    const bad = await admin.post('/api/admin/import/preview').send({ csv: csv.replace('Zach Sanders,40', 'Nobody Here,40') });
    expect(bad.body.summary.problems).toBe(1);
    expect(bad.body.rows[0].problems[0]).toMatch(/Nobody Here/);
    expect((await admin.post('/api/admin/import').send({ csv: csv.replace('Zach Sanders,40', 'Nobody Here,40') })).status).toBe(400);
    const preview = await admin.post('/api/admin/import/preview').send({ csv });
    expect(preview.body.summary).toMatchObject({ deals: 3, draws: 1, withPayouts: 1, clawbacks: 1, problems: 0 });
    expect(preview.body.rows.map((r: { action: string }) => r.action)).toEqual(['deal', 'deal', 'draw', 'deal']);
    const res = await admin.post('/api/admin/import').send({ csv });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ deals: 3, draws: 1, clawbacks: 1, payoutLines: 3 });
    const f10 = (await admin.get('/api/admin/deals/F10')).body;
    expect(f10).toMatchObject({ business: 'Harbor Street, LLC', funded: 100_000, gross: 14_000, commissionStatus: 'YES - Paid In Full', repPaid: '2026-05-01', storedDealStatus: 'Performing' });
    expect(f10.roles.map((r: { repId: string | null; paid: number }) => [r.repId, r.paid > 0])).toEqual([['rep-julian-ribak', true], ['rep-zach-sanders', true], ['rep-raymond-amato', true]]);
    const f11 = (await admin.get('/api/admin/deals/F11')).body;
    expect(f11.segments.map((s: { sk: string; amount: number }) => [s.sk, s.amount])).toEqual([['base', 50_000], ['D1', 20_000]]);
    expect(f11.commissionStatus).toBe('Partially Paid');
    const board = (await admin.get('/api/admin/deals')).body;
    const noId = board.deals.find((d: { business: string }) => d.business === 'No Id Co');
    expect(noId.id).toBe('F13');
    expect(noId.hasClawback).toBe(true);
    expect(noId.dealStatus).toBe('Default');
    const runs = (await admin.get('/api/admin/payroll')).body.runs;
    expect(runs.some((r: { label: string; status: string }) => r.label === 'Imported from sheet' && r.status === 'paid')).toBe(true);
    // importing the same file again is refused: the ids exist now
    expect((await admin.post('/api/admin/import/preview').send({ csv })).body.rows[0].problems[0]).toMatch(/already exists/);
  });
});
