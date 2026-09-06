import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { cashView, exceptions, partnerPayables, receivables } from '../src/services/books.js';
import { memoryMailer } from '../src/services/mail.js';
import { memoryRepo } from './memory-repo.js';

async function harness() {
  const repo = memoryRepo();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32) }), repo, { mailer: memoryMailer() });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  return { repo, app, admin };
}

describe('receivables', () => {
  it('ages what lenders still owe, using the lender terms or the global default', async () => {
    const { repo } = await harness();
    const [ctx, settings] = await Promise.all([repo.loadContext(), repo.getSettings()]);
    const r = receivables(ctx, settings, '2026-09-06');
    // F1 is collected; F2 (2,000) and F3 (500) are open.
    expect(r.total).toBe(2500);
    expect(r.rows.map((x) => [x.dealId, x.amount, x.item])).toEqual([['F2', 2000, 'Commission'], ['F3', 500, 'Commission']]);
    const terms = settings.thresholds.paymentOverdueDays;
    expect(r.rows[0]!.expected).toBe(new Date(Date.parse('2026-07-12T00:00:00Z') + terms * 86_400_000).toISOString().slice(0, 10));
    expect(r.rows[0]!.daysOverdue).toBeGreaterThan(30);
    expect(r.byLender).toEqual([{ lender: 'MBC', outstanding: 2500, overdue: 2500, termsDays: terms, rows: 2 }]);
    // Lender terms override the default and can pull a row back to "current".
    const later = { ...settings, lenders: settings.lenders.map((l) => (l.name === 'MBC' ? { ...l, paymentTermsDays: 90 } : l)) };
    const r2 = receivables(ctx, later, '2026-09-06');
    expect(r2.rows.find((x) => x.dealId === 'F3')!.bucket).toBe('current');
    expect(r2.rows.find((x) => x.dealId === 'F2')!.bucket).toBe('current');
    expect(r2.byBucket.current).toBe(2500);
    expect(receivables(ctx, later, '2026-11-15').rows.find((x) => x.dealId === 'F2')!.bucket).toBe('31-60');
  });
  it('is served to admins only, with lender terms saved from Settings › Lenders', async () => {
    const { admin, app } = await harness();
    expect((await admin.get('/api/admin/books/receivables')).body.total).toBe(2500);
    const lenders = (await admin.get('/api/admin/settings')).body.lenders.map((l: { name: string }) => (l.name === 'MBC' ? { ...l, paymentTermsDays: 30 } : l));
    const saved = await admin.put('/api/admin/settings/lenders').send({ lenders });
    expect(saved.body.lenders.find((l: { name: string }) => l.name === 'MBC').paymentTermsDays).toBe(30);
    expect((await admin.get('/api/admin/books/receivables')).body.byLender[0].termsDays).toBe(30);
    expect((await admin.put('/api/admin/settings/lenders').send({ lenders: lenders.map((l: { name: string }) => (l.name === 'MBC' ? { ...l, paymentTermsDays: 900 } : l)) })).status).toBe(400);
    const rep = request.agent(app);
    await rep.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    expect((await rep.get('/api/admin/books/receivables')).status).toBe(403);
  });
});

describe('partner payables', () => {
  it('lists fees owed per partner and marks them paid', async () => {
    const { repo, admin } = await harness();
    const before = partnerPayables(await repo.loadContext(), await repo.getSettings());
    expect(before.rows).toEqual([{ dealId: 'F2', business: 'F2 Business', lender: 'MBC', fundedDate: '2026-07-12', partner: 'HUB TRACKER', fee: 200, collected: false, commissionStatus: 'Waiting for payment', paidAt: null }]);
    expect(before.partners.find((p) => p.partner === 'HUB TRACKER')).toMatchObject({ owed: 200, owedCollected: 0, paid: 0, deals: 1 });
    expect(before.totals.owed).toBe(200);
    expect((await admin.post('/api/admin/books/partners/pay').send({ dealIds: [] })).status).toBe(400);
    const paid = await admin.post('/api/admin/books/partners/pay').send({ dealIds: ['F2', 'F1'], date: '2026-09-05' });
    expect(paid.body).toEqual({ updated: 1, date: '2026-09-05' });
    const after = (await admin.get('/api/admin/books/partners')).body;
    expect(after.rows[0].paidAt).toBe('2026-09-05');
    expect(after.totals).toEqual({ owed: 0, owedCollected: 0, paid: 200 });
    expect((await admin.get('/api/admin/audit').query({ action: 'deal.referral.paid' })).body.entries).toHaveLength(1);
    await admin.post('/api/admin/books/partners/pay').send({ dealIds: ['F2'], paid: false });
    expect((await admin.get('/api/admin/books/partners')).body.totals.owed).toBe(200);
  });
});

describe('cash view and books export', () => {
  it('shows each month accrual beside cash and exports a journal CSV', async () => {
    const { repo, admin } = await harness();
    const v = cashView(await repo.loadContext(), 2026);
    const m = Object.fromEntries(v.months.map((x) => [x.month, x]));
    expect(m['2026-06']).toMatchObject({ deals: 1, funded: 10000, grossEarned: 1000, referralFees: 0, repShares: 800, houseNet: 200, collected: 1000, outstanding: 0 });
    expect(m['2026-07']).toMatchObject({ deals: 1, grossEarned: 2000, referralFees: 200, collected: 0, outstanding: 2000 });
    expect(m['2026-08']).toMatchObject({ repPayouts: 350, recovered: 100, repCash: 250 });
    expect(v.total.grossEarned).toBe(3500);
    const csv = await admin.get('/api/admin/books/cash.csv').query({ year: 2026 });
    expect(csv.headers['content-disposition']).toMatch(/books-2026\.csv/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toBe('"Date","Account","Name","Memo","Deal","Amount"');
    expect(lines.some((l) => l.includes('"Commission income","MBC","F2 F2 Business · MCA","F2","2000.00"'))).toBe(true);
    expect(lines.some((l) => l.includes('"Referral fees","HUB TRACKER"') && l.includes('"-200.00"'))).toBe(true);
    expect(lines.some((l) => l.includes('"Commissions paid to reps","Julian Ribak"') && l.includes('"-350.00"'))).toBe(true);
    expect(lines.some((l) => l.includes('"Clawback recovered","Julian Ribak"') && l.includes('"100.00"'))).toBe(true);
    expect((await admin.get('/api/admin/books/cash').query({ year: 1999 })).status).toBe(400);
  });
});

describe('exceptions', () => {
  it('flags funded-but-unpaid deals, reps paid ahead of the lender, and fees owed on collected commission', async () => {
    const { repo, admin } = await harness();
    const ctx = await repo.loadContext();
    const settings = await repo.getSettings();
    const x = exceptions(ctx, settings, '2026-09-06');
    expect(x.counts['funded-no-commission']).toBe(2);
    expect(x.counts['overdue-receipt']).toBe(2);
    expect(x.counts['paid-before-collected']).toBe(0);
    // Pay Zach on F3 before MBC pays: exposure appears.
    ctx.lines.push({ key: 'F3|Opener|base', dealId: 'F3', segmentKey: 'base', role: 'Opener', repId: 'rep-zach-sanders', amount: 200, runId: 'run-3', clawbackId: null, paidAt: '2026-08-31' });
    const y = exceptions(ctx, settings, '2026-09-06');
    expect(y.items.find((i) => i.kind === 'paid-before-collected')).toMatchObject({ dealId: 'F3', amount: 200 });
    // Collect F2 and the partner fee becomes payable-now.
    await repo.updateDeal('F2', { commCollected: 2000 });
    const z = exceptions(await repo.loadContext(), settings, '2026-09-06');
    expect(z.items.find((i) => i.kind === 'partner-owed-collected')).toMatchObject({ dealId: 'F2', amount: 200 });
    expect((await admin.get('/api/admin/books/exceptions')).body.items.length).toBeGreaterThan(0);
  });
});

describe('rep-side exports and files', () => {
  it('gives a rep their pay history CSV, year-end totals, and a W-9 slot', async () => {
    const { app, admin } = await harness();
    const rep = request.agent(app);
    await rep.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    const csv = await rep.get('/api/me/payments.csv');
    expect(csv.headers['content-disposition']).toMatch(/my-pay-history\.csv/);
    expect(csv.text).toContain('"2026-08-31","F1","F1 Business","Opener","Initial","Aug 16 – Aug 31, 2026","350.00",""');
    expect(csv.text.trim().split('\r\n').at(-1)).toContain('"250.00"');
    const annual = await rep.get('/api/me/annual').query({ year: 2026 });
    expect(annual.body).toMatchObject({ year: 2026, years: ['2026'], grossPaid: 350, recovered: 100, cash: 250, payouts: 1, deals: 1 });
    expect((await rep.get('/api/me/annual').query({ year: 2020 })).body.cash).toBe(0);
    const pdf = Buffer.from('%PDF-1.4 w9').toString('base64');
    expect((await rep.post('/api/me/files').send({ name: 'W-9.pdf', mime: 'application/pdf', data: pdf })).status).toBe(201);
    const mine = (await rep.get('/api/me/files')).body.files;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'W-9.pdf', repId: 'rep-julian-ribak' });
    expect((await rep.get(`/api/me/files/${mine[0].id}`)).headers['content-type']).toMatch(/pdf/);
    // The admin sees it on the roster and can remove it; a rep cannot.
    const list = (await admin.get('/api/admin/reps/rep-julian-ribak/files')).body.files;
    expect(list[0]).toMatchObject({ name: 'W-9.pdf', uploadedByName: 'Julian Ribak' });
    expect((await admin.get(`/api/admin/reps/rep-julian-ribak/files/${list[0].id}`)).status).toBe(200);
    expect((await rep.delete(`/api/admin/reps/rep-julian-ribak/files/${list[0].id}`)).status).toBe(403);
    expect((await admin.delete(`/api/admin/reps/rep-julian-ribak/files/${list[0].id}`)).body.files).toEqual([]);
    expect((await admin.post('/api/admin/reps/rep-zach-sanders/files').send({ name: 'x.exe', mime: 'application/octet-stream', data: pdf })).status).toBe(400);
  });
});
