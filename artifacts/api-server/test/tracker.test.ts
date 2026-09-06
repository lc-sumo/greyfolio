import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryMailer } from '../src/services/mail.js';
import { buildIcs } from '../src/services/calendar.js';
import { memoryRepo } from './memory-repo.js';

async function harness() {
  const repo = memoryRepo();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test' }), repo, { mailer: memoryMailer() });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  return { repo, app, admin };
}

describe('renewal chains', () => {
  it('links a renewal at creation, marks the earlier deal Refinanced, and shows both ends of the chain', async () => {
    const { admin, repo } = await harness();
    const made = await admin.post('/api/admin/deals').send({ business: 'F1 Business', merchantEmail: 'f1@merchant.test', fundedDate: '2026-09-01', lender: 'MBC', product: 'MCA', amount: 15_000, termDays: 120, factor: 1.3, commRate: 10, openerId: 'rep-julian-ribak', closerId: 'rep-zach-sanders', renewedFromId: 'F1' });
    expect(made.status).toBe(201);
    expect(made.body.renewedFromId).toBe('F1');
    const f1 = (await admin.get('/api/admin/deals/F1')).body;
    expect(f1.dealStatus).toBe('Refinanced');
    expect(f1.renewedById).toBe(made.body.id);
    expect((await admin.post('/api/admin/deals').send({ business: 'x', fundedDate: '2026-09-01', lender: 'MBC', product: 'MCA', amount: 1000, termDays: 100, factor: 1.3, commRate: 10, renewedFromId: 'nope' })).status).toBe(400);
    // Link and unlink after the fact; ordering is checked.
    expect((await admin.patch('/api/admin/deals/F2/renewal').send({ renewedFromId: 'F3' })).status).toBe(400); // F3 funded after F2
    expect((await admin.patch('/api/admin/deals/F3/renewal').send({ renewedFromId: 'F2' })).body.renewedFromId).toBe('F2');
    expect((await repo.loadContext()).deals.find((d) => d.id === 'F2')!.dealStatus).toBe('Refinanced');
    expect((await admin.patch('/api/admin/deals/F3/renewal').send({ renewedFromId: null })).body.renewedFromId).toBeNull();
    // Merchants: chain and lifetime figures.
    const m = (await admin.get('/api/admin/merchants')).body.merchants.find((x: { email: string }) => x.email === 'f1@merchant.test');
    expect(m).toMatchObject({ dealCount: 2, renewals: 1, openPositions: 1 });
    expect(m.deals.find((x: { id: string }) => x.id === 'F1')).toMatchObject({ renewedById: made.body.id, owner: 'Zach Sanders' });
    const detail = await admin.get(`/api/admin/merchants/${encodeURIComponent('f1@merchant.test')}`);
    expect(detail.body.merchant.business).toBe('F1 Business');
    expect((await admin.get('/api/admin/merchants/business:nobody')).status).toBe(404);
  });
});

describe('scorecards', () => {
  it('reports production, renewal rate and task follow-through per rep', async () => {
    const { admin, repo } = await harness();
    await admin.post('/api/admin/deals').send({ business: 'F1 Business', merchantEmail: 'f1@merchant.test', fundedDate: '2026-09-01', lender: 'MBC', product: 'MCA', amount: 15_000, termDays: 120, factor: 1.3, commRate: 10, closerId: 'rep-zach-sanders', renewedFromId: 'F1' });
    const t = await admin.post('/api/admin/deals/F2/tasks').send({ title: 'Call', dueDate: '2026-12-31' });
    await admin.patch(`/api/admin/tasks/${t.body.id}`).send({ outcome: 'funded' });
    const t2 = await admin.post('/api/admin/deals/F3/tasks').send({ title: 'Call again', dueDate: '2020-01-01' });
    await admin.patch(`/api/admin/tasks/${t2.body.id}`).send({ outcome: 'declined' });
    await admin.post('/api/admin/deals/F3/tasks').send({ title: 'Open one', dueDate: '2020-01-02' });
    const r = await admin.get('/api/admin/scorecards').query({ year: 2026 });
    const zach = r.body.rows.find((x: { repId: string }) => x.repId === 'rep-zach-sanders');
    expect(zach).toMatchObject({ deals: 4, renewed: 1, tasksClosed: 2, tasksWon: 1, taskWinRate: 50, onTimeRate: 50, openTasks: 1, overdueTasks: 1 });
    expect(zach.renewalRate).toBeGreaterThan(0);
    expect(zach.daysToClose).toBe(0);
    const julian = r.body.rows.find((x: { repId: string }) => x.repId === 'rep-julian-ribak');
    expect(julian.deals).toBe(2);
    expect((await repo.listTasks()).length).toBe(3);
  });
});

describe('calendar feed', () => {
  it('issues a private ICS link with tasks and renewal dates, revokable, invisible under View as', async () => {
    const { app, admin } = await harness();
    const zach = request.agent(app);
    await zach.get('/auth/dev-login').query({ email: 'zach.sanders@greystoneus.com' });
    expect((await zach.get('/api/me/calendar')).body).toEqual({ url: null, enabled: false });
    await admin.post('/api/admin/deals/F3/tasks').send({ title: 'Call Daniel about a draw', dueDate: '2026-10-01' });
    const made = await zach.post('/api/me/calendar');
    expect(made.body.url).toMatch(/^https:\/\/portal\.test\/calendar\/[A-Za-z0-9_-]+\.ics$/);
    const path = new URL(made.body.url).pathname;
    const ics = await request(app).get(path);
    expect(ics.status).toBe(200);
    expect(ics.headers['content-type']).toMatch(/text\/calendar/);
    expect(ics.text).toContain('BEGIN:VCALENDAR');
    expect(ics.text).toContain('SUMMARY:Call Daniel about a draw');
    expect(ics.text).toContain('DTSTART;VALUE=DATE:20261001');
    expect(ics.text).toMatch(/SUMMARY:F3 Business: (eligible for more capital|renewable|matures)/);
    // Admin viewing as Zach does not get the link; a bad token is 404; revoke kills it.
    expect((await admin.get('/api/me/calendar').set('X-View-As', 'rep-zach-sanders')).body.url).toBeNull();
    expect((await request(app).get('/calendar/nope.ics')).status).toBe(404);
    await zach.delete('/api/me/calendar');
    expect((await request(app).get(path)).status).toBe(404);
    // ICS escaping
    const text = buildIcs({ id: 'r', name: 'A B', email: 'a@b', role: 'rep', teamId: null, openerRate: 0, closerRate: 0, overrideRate: null, active: true }, { deals: [], lines: [], clawbacks: [] }, { thresholds: { renewalMark: 0.4, additionalCapitalAfterDays: 30, clawbackWindowDays: 30, paymentOverdueDays: 14 } } as never, [{ id: 't', dealId: 'x', repId: 'r', playbookId: null, title: 'Semi; colon, comma', dueDate: '2026-01-01', status: 'open', outcome: null, note: null, createdBy: null, createdAt: '', doneAt: null }], '2026-01-01', 'P');
    expect(text).toContain('SUMMARY:Semi\; colon\\, comma');
  });
});

describe('re-import refresh', () => {
  const HEADER = 'Deal ID,Parent Deal,Date,Business Name,Lender,Product,Funded / Draw Amount ($),Factor Rate,Term (bus. days),Payback ($),Frequency,Comm %,PSF (% or $),PSF $ (auto),Gross Commission ($),Referral Partner,Referral %,Referral Fee ($),Net Comm After Referral ($),Opener,Opener %,Opener $,Closer,Closer %,Closer $,Override Rep,Override %,Override $,Total Rep Payout ($),HOUSE NET ($),Clawback $,Clawback Date,Opener CB $,Closer CB $,Override CB $,Rep Clawback $,House Clawback $,House Net After Clawback ($),Commission Status,Lender Paid Date,Rep Paid Date,Est. Renewal (40% in),Deal Status,Maturity Date,Notes,CB Risk,Lead Source';
  const cols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT', 'AU']);
  const row = (v: Record<string, string>) => cols.map((c) => v[c] ?? '').join(',');
  it('updates only the ops status and lender-paid date on rows already in the portal', async () => {
    const { admin, repo } = await harness();
    const csv = [HEADER, row({ A: 'F1', C: '6/5/2026', D: 'F1 Business', E: 'MBC', F: 'MCA', G: '10000', H: '1.3', I: '120', K: 'Daily', L: '10', T: 'Julian Ribak', U: '35', W: 'Zach Sanders', X: '40', AM: 'YES - Paid In Full', AN: '6/20/2026', AQ: 'Paid In Full' })].join('\n');
    const plain = await admin.post('/api/admin/import/preview').send({ csv, skipExisting: true });
    expect(plain.body.rows[0].action).toBe('skip');
    const prev = await admin.post('/api/admin/import/preview').send({ csv, updateExisting: true });
    expect(prev.body.rows[0].action).toBe('update');
    expect(prev.body.rows[0].changes).toEqual(['status → Paid In Full', 'lender paid 2026-06-20']);
    expect(prev.body.updated).toBe(1);
    expect(prev.body.summary.deals).toBe(0);
    const done = await admin.post('/api/admin/import').send({ csv, updateExisting: true });
    expect(done.body).toMatchObject({ deals: 0, updated: 1 });
    const f1 = (await repo.loadContext()).deals.find((d) => d.id === 'F1')!;
    expect(f1.dealStatus).toBe('Paid In Full');
    expect(f1.lenderPaid).toBe('2026-06-20');
    expect(f1.funded).toBe(10_000); // money untouched
    expect((await admin.post('/api/admin/import/preview').send({ csv, updateExisting: true })).body.rows[0].action).toBe('skip');
  });
});
