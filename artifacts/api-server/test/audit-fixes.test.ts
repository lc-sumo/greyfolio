import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryMailer } from '../src/services/mail.js';
import { memoryRepo } from './memory-repo.js';

async function harness() {
  const repo = memoryRepo();
  const mailer = memoryMailer();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test' }), repo, { mailer });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  const rep = request.agent(app);
  await rep.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
  return { repo, app, admin, rep, mailer };
}

describe('payroll runs: close out and reopen', () => {
  it('removes an empty draft, refuses a run with payouts, and reopens an approved run', async () => {
    const { admin } = await harness();
    // run-4 is a draft with nothing paid in it → removable; run-3 is paid → locked.
    expect((await admin.delete('/api/admin/payroll/runs/run-3')).status).toBe(400);
    await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    const busy = await admin.delete('/api/admin/payroll/runs/run-4');
    expect(busy.status).toBe(400);
    expect(busy.body.error).toMatch(/payouts recorded/);
    await admin.post('/api/admin/payroll/runs/run-4/advance');
    expect((await admin.post('/api/admin/payroll/runs/run-4/reopen')).body.status).toBe('draft');
    expect((await admin.post('/api/admin/payroll/runs/run-4/reopen')).status).toBe(400);
    const extra = await admin.post('/api/admin/payroll/runs').send({ start: '2026-10-01', end: '2026-10-15' });
    expect(extra.status).toBe(201);
    expect((await admin.delete(`/api/admin/payroll/runs/${extra.body.id}`)).body).toEqual({ deleted: extra.body.id });
    expect((await admin.get('/api/admin/payroll')).body.runs.some((r: { id: string }) => r.id === extra.body.id)).toBe(false);
  });
  it('an import run never blocks the next real pay period', async () => {
    const { repo, admin } = await harness();
    await repo.insertRun({ id: 'import-2026-09-04', label: 'Imported from sheet', start: '2025-01-01', end: '2026-09-04', status: 'paid' });
    const r = await admin.post('/api/admin/payroll/runs').send({});
    expect(r.status).toBe(201);
    expect(r.body.start).toBe('2026-09-16');
  });
});

describe('draws: edit and remove', () => {
  async function withDraw(admin: request.Agent) {
    const created = await admin.post('/api/admin/deals').send({ business: 'Line Co', fundedDate: '2026-08-01', lender: 'Revenued', product: 'LOC - INITIAL', termDays: 120, amount: 20_000, creditLine: 90_000, drawInitialPct: 5, drawSubsequentPct: 5, lineRate: 0, openerId: 'rep-julian-ribak', openerRate: 0.35 });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await admin.post(`/api/admin/deals/${id}/draws`).send({ amount: 10_000, termDays: 60, factor: 1.2 });
    return id;
  }
  it('re-prices a draw in place and removes one entered by mistake', async () => {
    const { admin } = await harness();
    const id = await withDraw(admin);
    let d = (await admin.get(`/api/admin/deals/${id}`)).body;
    expect(d.segments).toHaveLength(2);
    expect(d.segments[1]).toMatchObject({ sk: 'D1', amount: 10_000, gross: 500 });
    const edited = await admin.patch(`/api/admin/deals/${id}/draws/D1`).send({ amount: 12_000, date: '2026-08-15', commRate: 4 });
    expect(edited.status).toBe(200);
    expect(edited.body.segments[1]).toMatchObject({ sk: 'D1', amount: 12_000, gross: 480, date: '2026-08-15', commRate: 0.04 });
    expect(edited.body.funded).toBe(32_000);
    expect((await admin.patch(`/api/admin/deals/${id}/draws/D9`).send({ amount: 1 })).status).toBe(404);
    const removed = await admin.delete(`/api/admin/deals/${id}/draws/D1`);
    expect(removed.status).toBe(200);
    expect(removed.body.segments).toHaveLength(1);
    expect(removed.body.funded).toBe(20_000);
  });
  it('refuses to touch a draw that has been paid on', async () => {
    const { admin } = await harness();
    const id = await withDraw(admin);
    await admin.post(`/api/admin/deals/${id}/collection`).send({ segmentKey: 'D1', status: 'YES - Paid In Full' });
    const pay = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: [`${id}|Opener|D1`] });
    expect(pay.status).toBe(201);
    expect((await admin.delete(`/api/admin/deals/${id}/draws/D1`)).body.error).toMatch(/paid on/);
    expect((await admin.patch(`/api/admin/deals/${id}/draws/D1`).send({ amount: 1 })).body.error).toMatch(/paid on/);
  });
  it('prices the Revenued line fee: % of the line at open plus the draw %, subsequent draws on the draw only', async () => {
    const { admin } = await harness();
    const created = await admin.post('/api/admin/deals').send({ business: 'Rev Co', fundedDate: '2026-08-01', lender: 'Revenued', product: 'LOC - INITIAL', termDays: 120, amount: 50_000, creditLine: 90_000, commRate: 5, drawInitialPct: 5, drawSubsequentPct: 5, openerId: 'rep-julian-ribak', openerRate: 0.4, closerId: 'rep-julian-ribak', closerRate: 0 });
    expect(created.status).toBe(201);
    // Revenued seeds a 5% line fee: 5% × 90,000 + 5% × 50,000 = 7,000 gross.
    expect(created.body).toMatchObject({ lineRate: 0.05, lineFee: 4_500, gross: 7_000 });
    const drawn = await admin.post(`/api/admin/deals/${created.body.id}/draws`).send({ amount: 20_000 });
    expect(drawn.body.segments[1].gross).toBe(1_000);
    const plain = await admin.post('/api/admin/deals').send({ business: 'Plain Co', fundedDate: '2026-08-01', lender: 'Revenued', product: 'LOC - INITIAL', termDays: 120, amount: 50_000, creditLine: 90_000, commRate: 5, drawInitialPct: 5, drawSubsequentPct: 5, lineRate: 0, openerId: 'rep-julian-ribak', openerRate: 0.4 });
    expect(plain.body).toMatchObject({ lineRate: 0, lineFee: 0, gross: 2_500 });
  });
});

describe('clawbacks: edit, forgive, cap', () => {
  it('edits amount/date/reason, caps the total at gross, and forgives one nobody has repaid', async () => {
    const { admin } = await harness();
    const rec = await admin.post('/api/admin/deals/F2/clawbacks').send({ amount: 1_500, date: '2026-08-01', reason: 'typo' });
    expect(rec.status).toBe(201);
    expect((await admin.post('/api/admin/deals/F2/clawbacks').send({ amount: 600, date: '2026-08-02' })).body.error).toMatch(/together they cannot exceed/);
    const ed = await admin.patch('/api/admin/deals/F2/clawbacks/cb-F2-1').send({ amount: 500, reason: 'Merchant defaulted' });
    expect(ed.body.clawbacks[0]).toMatchObject({ amount: 500, reason: 'Merchant defaulted' });
    expect((await admin.patch('/api/admin/deals/F2/clawbacks/cb-F2-1').send({ date: '2027-01-01' })).status).toBe(400);
    const gone = await admin.delete('/api/admin/deals/F2/clawbacks/cb-F2-1');
    expect(gone.body.clawbacks).toHaveLength(0);
    // cb-1 on F1 has a recovery row → cannot be forgiven, and cannot drop below what was recovered.
    expect((await admin.delete('/api/admin/deals/F1/clawbacks/cb-1')).body.error).toMatch(/repaid on this clawback/);
    expect((await admin.patch('/api/admin/deals/F1/clawbacks/cb-1').send({ amount: 50 })).body.error).toMatch(/already repaid/);
  });
});

describe('merchant contact', () => {
  it('can be corrected on a paid deal and applied across the merchant', async () => {
    const { admin } = await harness();
    // F1 has ledger rows, so terms are frozen — contact is not.
    const one = await admin.patch('/api/admin/deals/F1/contact').send({ merchantContact: 'Dana Reyes', merchantPhone: '(201) 555-0199' });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ merchantContact: 'Dana Reyes', merchantPhone: '(201) 555-0199', updatedDeals: 1 });
    expect((await admin.patch('/api/admin/deals/F1/contact').send({ merchantEmail: 'nope' })).status).toBe(400);
    // Point F2 at F1's email, then change the email merchant-wide from F1: both move together.
    await admin.patch('/api/admin/deals/F2/contact').send({ merchantEmail: 'f1@merchant.test' });
    const all = await admin.patch('/api/admin/deals/F1/contact').send({ merchantEmail: 'new@merchant.test', applyToMerchant: true });
    expect(all.body.updatedDeals).toBe(2);
    expect((await admin.get('/api/admin/deals/F2')).body.merchantEmail).toBe('new@merchant.test');
  });
});

describe('xlsx import with missing-reference notices', () => {
  it('reads the workbook, dates included, and lists what Settings does not know yet', async () => {
    const { admin } = await harness();
    const xlsx = readFileSync(new URL('./fixtures/funded-mini.xlsx', import.meta.url)).toString('base64');
    const pv = await admin.post('/api/admin/import/preview').send({ xlsx });
    expect(pv.status).toBe(200);
    expect(pv.body.rows).toHaveLength(2);
    expect(pv.body.rows[0]).toMatchObject({ id: 'F20', business: 'Xlsx Co', date: '2026-08-03', amount: 50_000, problems: [] });
    expect(pv.body.missing).toEqual({ lenders: ['Fresh Lender'], products: [], partners: ['Mystery Partner'], reps: ['Unknown Rep'] });
    expect(pv.body.summary.problems).toBe(3);
    expect((await admin.post('/api/admin/import/preview').send({ xlsx: 'AAAA' })).status).toBe(400);
    // Add what was missing, then the same upload is clean.
    const s = (await admin.get('/api/admin/settings')).body;
    await admin.put('/api/admin/settings/lenders').send({ lenders: [...s.lenders, { name: 'Fresh Lender', terms: 'upfront', weeks: 0, products: [] }] });
    await admin.put('/api/admin/settings/partners').send({ partners: [...s.partners, { name: 'Mystery Partner', pct: 0.1, monthlyCap: null }] });
    await admin.post('/api/admin/reps').send({ name: 'Unknown Rep', email: 'unknown.rep@greystoneus.com', role: 'rep', teamId: null, openerRate: 0.2, closerRate: 0.2, overrideRate: null });
    const again = await admin.post('/api/admin/import/preview').send({ xlsx });
    expect(again.body.summary.problems).toBe(0);
    expect(again.body.missing).toEqual({ lenders: [], products: [], partners: [], reps: [] });
    const done = await admin.post('/api/admin/import').send({ xlsx });
    expect(done.status).toBe(201);
    expect(done.body.deals).toBe(2);
  });
});

describe('settings: rename in use, retire', () => {
  it('renames a lender across its deals and retires one without removing it', async () => {
    const { admin } = await harness();
    const s = (await admin.get('/api/admin/settings')).body;
    const lenders = s.lenders.map((l: { name: string }) => (l.name === 'MBC' ? { ...l, name: 'MBC Capital', renamedFrom: 'MBC' } : l));
    const saved = await admin.put('/api/admin/settings/lenders').send({ lenders });
    expect(saved.status).toBe(200);
    expect((await admin.get('/api/admin/deals/F1')).body.lender).toBe('MBC Capital');
    const retired = saved.body.lenders.map((l: { name: string }) => (l.name === 'MBC Capital' ? { ...l, active: false } : l));
    const r2 = await admin.put('/api/admin/settings/lenders').send({ lenders: retired });
    expect(r2.body.lenders.find((l: { name: string }) => l.name === 'MBC Capital').active).toBe(false);
    // Plain removal of an in-use name is still refused.
    expect((await admin.put('/api/admin/settings/lenders').send({ lenders: retired.filter((l: { name: string }) => l.name !== 'MBC Capital') })).status).toBe(400);
  });
});

describe('rep-facing fixes', () => {
  it('the leaderboard shows ranks, never another rep’s dollars', async () => {
    const { rep } = await harness();
    const lb = (await rep.get('/api/me/leaderboard')).body.rows as Array<{ isMe: boolean; commission: number | null }>;
    expect(lb.length).toBeGreaterThan(1);
    expect(lb.filter((r) => !r.isMe).every((r) => r.commission === null)).toBe(true);
    expect(lb.find((r) => r.isMe)!.commission).toBeGreaterThan(0);
  });
  it('a rep can ask about their deal: note on the deal, email to admins', async () => {
    const { rep, admin, mailer } = await harness();
    expect((await rep.post('/api/me/deals/F3/question').send({ text: 'hello' })).status).toBe(404); // not Julian's deal
    const q = await rep.post('/api/me/deals/F2/question').send({ text: 'My closer split should be 40%.' });
    expect(q.status).toBe(201);
    expect(q.body.emailed).toBe(1);
    expect(mailer.sent[0]).toMatchObject({ to: ['leor@greystoneus.com'] });
    expect((await admin.get('/api/admin/deals/F2/notes')).body.notes[0].body).toMatch(/^\[Question from Julian Ribak\] My closer split/);
  });
  it('a deactivated rep loses access on the next request', async () => {
    const { rep, admin } = await harness();
    expect((await rep.get('/api/me/wallet')).status).toBe(200);
    await admin.patch('/api/admin/reps/rep-julian-ribak').send({ active: false });
    const r = await rep.get('/api/me/wallet');
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/inactive/);
  });
  it('next payout is null rather than a past date when no run is open', async () => {
    const { rep, admin } = await harness();
    await admin.post('/api/admin/payroll/runs/run-4/advance');
    await admin.post('/api/admin/payroll/runs/run-4/advance');
    const d = (await rep.get('/api/me/dashboard').query({ to: '2026-09-20' })).body;
    expect(d.nextPayout.date).toBeNull();
  });
  it('audit log pages and exports', async () => {
    const { admin } = await harness();
    await admin.get('/api/admin/settings'); await admin.patch('/api/admin/deals/F2/crm').send({ crmId: 'OPP-1' }); await admin.patch('/api/admin/deals/F2/crm').send({ crmId: 'OPP-2' });
    const page = await admin.get('/api/admin/audit').query({ limit: 2, offset: 1 });
    expect(page.body.entries).toHaveLength(2);
    expect(page.body).toMatchObject({ limit: 2, offset: 1 });
    const only = await admin.get('/api/admin/audit').query({ action: 'login' });
    expect(only.body.entries.every((e: { action: string }) => e.action === 'login')).toBe(true);
    const csv = await admin.get('/api/admin/audit.csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('"At","Actor","Action","Target","Path","Detail"');
  });
});
