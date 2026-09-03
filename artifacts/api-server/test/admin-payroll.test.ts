import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { nextPeriod } from '../src/services/payroll.js';
import { repLedger } from '@greystone/commission';
import { clawbacks, deals, lines, memoryRepo } from './memory-repo.js';

const config = configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'test-secret', PORT: '0' });
const today = new Date().toISOString().slice(0, 10);

async function harness() {
  const repo = memoryRepo();
  const app = createApp(config, repo);
  const as = async (email: string) => {
    const agent = request.agent(app);
    await agent.get('/auth/dev-login').query({ email });
    return agent;
  };
  return { repo, admin: await as('leor@greystoneus.com'), rep: await as('julian.ribak@greystoneus.com'), mgr: await as('raymond.amato@greystoneus.com') };
}

describe('nextPeriod', () => {
  it('follows the latest run twice-monthly, or contains today when there are none', () => {
    expect(nextPeriod([{ id: 'x', label: '', start: '2026-08-16', end: '2026-08-31', status: 'paid' }])).toEqual({ start: '2026-09-01', end: '2026-09-15' });
    expect(nextPeriod([{ id: 'x', label: '', start: '2026-09-01', end: '2026-09-15', status: 'paid' }])).toEqual({ start: '2026-09-16', end: '2026-09-30' });
    expect(nextPeriod([{ id: 'x', label: '', start: '2026-12-16', end: '2026-12-31', status: 'paid' }])).toEqual({ start: '2027-01-01', end: '2027-01-15' });
    expect(nextPeriod([], '2026-02-20')).toEqual({ start: '2026-02-16', end: '2026-02-28' });
    expect(nextPeriod([], '2026-02-03')).toEqual({ start: '2026-02-01', end: '2026-02-15' });
  });
});

describe('payroll is admin-only', () => {
  it('reps and team leads get 403 everywhere', async () => {
    const { rep, mgr } = await harness();
    for (const a of [rep, mgr]) {
      expect((await a.get('/api/admin/payroll')).status).toBe(403);
      expect((await a.post('/api/admin/payroll/runs').send({})).status).toBe(403);
      expect((await a.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] })).status).toBe(403);
      expect((await a.get('/api/admin/payroll/runs/run-3/export.csv')).status).toBe(403);
    }
  });
});

describe('GET /api/admin/payroll', () => {
  it('lists runs with ledger totals and reps sorted by owed', async () => {
    const { admin } = await harness();
    const res = await admin.get('/api/admin/payroll');
    expect(res.status).toBe(200);
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual(['run-4', 'run-3']);
    expect(res.body.runs[1]).toMatchObject({ id: 'run-3', paidGross: 350, recovered: 100, cash: 250, repCount: 1, lineCount: 1 });
    // Every figure is repLedger's — the same number the rep's wallet shows.
    const ctx = { deals, lines, clawbacks };
    const owed = (id: string) => repLedger(ctx, id).owed;
    const reps: Array<{ id: string; owed: number; lineCount: number }> = res.body.reps;
    for (const r of reps) expect(r.owed).toBe(owed(r.id));
    expect(Object.fromEntries(reps.map((r) => [r.id, r.lineCount]))).toMatchObject({ 'rep-zach-sanders': 4, 'rep-julian-ribak': 1, 'rep-raymond-amato': 2 });
    const sorted = [...reps].sort((a, b) => b.owed - a.owed || a.id.localeCompare(b.id));
    expect(reps.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
    expect(res.body.reps.find((r: { id: string }) => r.id === 'rep-zach-sanders').held).toBe(400);
    expect(res.body.outstanding).toBe(res.body.reps.reduce((s: number, r: { owed: number }) => s + r.owed, 0));
  });
});

describe('runs', () => {
  it('creates the next twice-monthly run, refuses overlaps, and advances draft → approved → paid', async () => {
    const { admin } = await harness();
    const created = await admin.post('/api/admin/payroll/runs').send({});
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'run-2026-09-16', label: 'Sep 16 – Sep 30, 2026', status: 'draft' });
    expect((await admin.post('/api/admin/payroll/runs').send({ start: '2026-09-10', end: '2026-09-20' })).body.error).toMatch(/already covers/);
    expect((await admin.post('/api/admin/payroll/runs/run-4/advance')).body.status).toBe('approved');
    expect((await admin.post('/api/admin/payroll/runs/run-4/advance')).body.status).toBe('paid');
    expect((await admin.post('/api/admin/payroll/runs/run-4/advance')).status).toBe(400);
    expect((await admin.post('/api/admin/payroll/runs/nope/advance')).status).toBe(404);
  });
});

describe('per-rep payroll detail', () => {
  it('lists payable lines with collection state, the clawback queue, and what was paid in the run', async () => {
    const { admin } = await harness();
    const res = await admin.get('/api/admin/payroll/runs/run-3/reps/rep-julian-ribak');
    expect(res.body.rep).toMatchObject({ id: 'rep-julian-ribak', name: 'Julian Ribak' });
    expect(res.body.lines).toEqual([expect.objectContaining({ key: 'F2|Opener|base', segmentLabel: 'Initial', business: 'F2 Business', role: 'Opener', rate: 0.35, amount: 630, lenderPaidLabel: 'Not collected', collected: false, collectedKeys: [], uncollectedKeys: ['F2|Opener|base'], uncollectedAmount: 630, units: null })]);
    expect(res.body.clawbacks).toEqual([{ id: 'cb-1', dealId: 'F1', business: 'F1 Business', date: '2026-08-15', remaining: 250 }]);
    expect(res.body.outstandingClawback).toBe(250);
    expect(res.body.paidInRun.map((p: { role: string; amount: number }) => [p.role, p.amount])).toEqual([['Opener', 350], ['Clawback recovery', -100]]);
    expect(res.body.paidSummary).toEqual({ gross: 350, recovered: 100, cash: 250, lineCount: 1 });
  });
  it('previews netting before commit', async () => {
    const { admin } = await harness();
    const res = await admin.post('/api/admin/payroll/preview').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    expect(res.body).toEqual({ gross: 630, withheld: 250, net: 380, outstandingClawback: 250 });
  });
});

describe('POST pay', () => {
  it('writes ledger rows and a recovery row, rolls up the clawback, stamps repPaid, and pins the rep', async () => {
    const { admin, repo } = await harness();
    const res = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ repId: 'rep-julian-ribak', runId: 'run-4', gross: 630, withheld: 250, net: 380, lines: 1, recoveries: 1, dealsFullyPaid: [], uncollectedDealIds: ['F2'] });
    expect(repo.data.lines.filter((l) => l.runId === 'run-4').map((l) => [l.role, l.amount, l.clawbackId])).toEqual([['Opener', 630, null], ['Clawback recovery', -250, 'cb-1']]);
    expect(repo.data.clawbacks[0]).toMatchObject({ recovered: 350, status: 'open' }); // Zach and Raymond still owe theirs
    expect(repo.audit.at(-1)).toMatchObject({ action: 'payroll.pay', targetRepId: 'rep-julian-ribak' });
    // Wallet agrees with the ledger the run just wrote.
    const wallet = await admin.get('/api/me/wallet').set('X-View-As', 'rep-julian-ribak');
    expect(wallet.body).toMatchObject({ earned: 980, paid: 980, cash: 630, held: 0, recovered: 350, owed: 0 });
    // Paying the same line again is refused.
    expect((await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] })).body.error).toMatch(/already paid/);
  });
  it('stamps repPaid when every line on every segment is settled', async () => {
    const { admin, repo } = await harness();
    // F3: Zach opener + closer only.
    const res = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-zach-sanders', selectedKeys: ['F3|Opener|base', 'F3|Closer|base'] });
    expect(res.body.dealsFullyPaid).toEqual(['F3']);
    expect(repo.data.deals.find((d) => d.id === 'F3')?.repPaid).toBe(today);
  });
  it('refuses a locked run, an unknown rep, an empty selection, and another rep\'s line', async () => {
    const { admin } = await harness();
    expect((await admin.post('/api/admin/payroll/runs/run-3/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] })).body.error).toMatch(/locked/);
    expect((await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-ghost', selectedKeys: ['F2|Opener|base'] })).status).toBe(404);
    expect((await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: [] })).body.error).toMatch(/at least one/);
    expect((await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F1|Closer|base'] })).body.error).toMatch(/not payable/);
  });
});

describe('increments paid to reps', () => {
  it('a consolidation pays per lender receipt; the row tracks 4/20 paid', async () => {
    const { admin } = await harness();
    // $100k consolidation on ROWAN (20 weekly increments), Julian opener 35%, no closer/override.
    const created = await admin.post('/api/admin/deals').send({ business: 'Consol Co', fundedDate: today, lender: 'ROWAN', product: 'CONSOLIDATION - UPFRONT COMM', amount: 100_000, termDays: 200, factor: 1.3, commRate: 10, openerId: 'rep-julian-ribak', openerRate: 35, referralPartner: null });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await admin.post(`/api/admin/deals/${id}/collection`).send({ segmentKey: 'base', recordWeeks: 4 });
    let detail = (await admin.get(`/api/admin/payroll/runs/run-4/reps/rep-julian-ribak`)).body;
    const row = detail.lines.find((l: { dealId: string }) => l.dealId === id);
    expect(row).toMatchObject({ amount: 3_500, collectedAmount: 700, uncollectedAmount: 2_800, collected: false, lenderPaidLabel: '4/20 wks', units: { paid: 0, total: 20, collected: 4 } });
    expect(row.collectedKeys).toEqual([1, 2, 3, 4].map((n) => `${id}|Opener|base|u${n}`));
    const pay = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: row.collectedKeys });
    expect(pay.body).toMatchObject({ gross: 700, lines: 4, uncollectedDealIds: [] });
    detail = (await admin.get(`/api/admin/payroll/runs/run-4/reps/rep-julian-ribak`)).body;
    expect(detail.lines.find((l: { dealId: string }) => l.dealId === id)).toMatchObject({ amount: 2_800, collectedAmount: 0, uncollectedAmount: 2_800, units: { paid: 4, total: 20, collected: 4 } });
    expect(detail.paidInRun.filter((p: { dealId: string }) => p.dealId === id).map((p: { unitLabel: string }) => p.unitLabel)).toEqual(['Increment 1', 'Increment 2', 'Increment 3', 'Increment 4']);
    // the drawer and the rep's own view agree
    const deal = (await admin.get(`/api/admin/deals/${id}`)).body;
    expect(deal.segments[0].schedule.paidToReps).toEqual([{ role: 'Opener', repId: 'rep-julian-ribak', name: 'Julian Ribak', paid: 4, total: 20 }]);
    const mine = (await admin.get(`/api/me/deals/${id}`).set('X-View-As', 'rep-julian-ribak')).body;
    expect(mine.lines[0]).toMatchObject({ role: 'Opener', amount: 3_500, paidAmount: 700, paid: false, units: { paid: 4, total: 20, collected: 4 } });
    expect(mine.payments.map((p: { unit: string }) => p.unit)).toEqual(['Increment 1', 'Increment 2', 'Increment 3', 'Increment 4']);
    expect((await admin.get('/api/me/wallet').set('X-View-As', 'rep-julian-ribak')).body).toMatchObject({ paid: 350 + 700 });
  });
});

describe('CSV export', () => {
  it('returns the run ledger as CSV, optionally for one rep', async () => {
    const { admin } = await harness();
    const res = await admin.get('/api/admin/payroll/runs/run-3/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toBe('"Run","Rep","Deal","Business","Segment","Role","Amount","Paid at","Clawback"');
    expect(res.text).toContain('"run-3","Julian Ribak","F1","F1 Business","base","Opener","350.00","2026-08-31",""');
    expect(res.text).toContain('"Clawback recovery","-100.00","2026-08-31","cb-1"');
    expect((await admin.get('/api/admin/payroll/runs/run-3/export.csv?rep=rep-zach-sanders')).text.split('\r\n').filter(Boolean)).toHaveLength(1);
  });
});
