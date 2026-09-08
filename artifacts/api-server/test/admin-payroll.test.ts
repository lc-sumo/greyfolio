import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { paySelected, nextPeriod } from '../src/services/payroll.js';
import { updateTerms } from '../src/services/deals.js';
import { planPayout, repLedger, scheduleFor, type PayoutPlan } from '@greystone/commission';
import { clawbacks, deals, lines, memoryRepo } from './memory-repo.js';
import { memoryMailer, type Mailer } from '../src/services/mail.js';
import { notifyPayoutRecorded } from '../src/services/notify.js';
import { payableUnitsFor } from '../src/payroll-views.js';

const config = configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'test-secret', PORT: '0' });
const today = new Date().toISOString().slice(0, 10);

async function harness(mailer: Mailer = memoryMailer()) {
  const repo = memoryRepo();
  // Successful payroll paths use an authoritative lender receipt; separate
  // tests cover rejection of uncollected advances.
  await repo.updateDeal('F2', { commCollected: 2_000 });
  const app = createApp(config, repo, { mailer });
  const as = async (email: string) => {
    const agent = request.agent(app);
    await agent.get('/auth/dev-login').query({ email });
    return agent;
  };
  return { repo, mailer: mailer as ReturnType<typeof memoryMailer>, admin: await as('leor@greystoneus.com'), rep: await as('julian.ribak@greystoneus.com'), mgr: await as('raymond.amato@greystoneus.com') };
}

describe('nextPeriod', () => {
  it('follows the latest run twice-monthly, or contains today when there are none', () => {
    expect(nextPeriod([{ id: 'x', label: '', start: '2026-08-16', end: '2026-08-31', status: 'paid' }])).toEqual({ start: '2026-09-01', end: '2026-09-15' });
    expect(nextPeriod([{ id: 'x', label: '', start: '2026-09-01', end: '2026-09-15', status: 'paid' }])).toEqual({ start: '2026-09-16', end: '2026-09-30' });
    expect(nextPeriod([{ id: 'x', label: '', start: '2026-12-16', end: '2026-12-31', status: 'paid' }])).toEqual({ start: '2027-01-01', end: '2027-01-15' });
    expect(nextPeriod([{ id: 'x', label: '', start: '2026-08-16', end: '2026-08-31', status: 'archived' }], '2026-08-20')).toEqual({ start: '2026-08-16', end: '2026-08-31' });
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
    const ctx = { deals: deals.map((d) => d.id === 'F2' ? { ...d, commCollected: 2_000 } : d), lines, clawbacks };
    const owed = (id: string) => repLedger(ctx, id).owed;
    const reps: Array<{ id: string; owed: number; lineCount: number }> = res.body.reps;
    for (const r of reps) expect(r.owed).toBe(owed(r.id));
    expect(Object.fromEntries(reps.map((r) => [r.id, r.lineCount]))).toMatchObject({ 'rep-zach-sanders': 4, 'rep-julian-ribak': 1, 'rep-raymond-amato': 2 });
    const sorted = [...reps].sort((a, b) => b.owed - a.owed || a.id.localeCompare(b.id));
    expect(reps.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
    expect(res.body.reps.find((r: { id: string }) => r.id === 'rep-zach-sanders').held).toBe(400);
    expect(res.body.outstanding).toBe(res.body.reps.reduce((s: number, r: { owed: number }) => s + r.owed, 0));
    expect(res.body.balance).toBe(res.body.outstanding);
    expect(res.body.payable).toBe(res.body.reps.reduce((s: number, r: { payable: number }) => s + r.payable, 0));
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

  it('archives draft or approved excess runs without deleting ledger history, while paid runs stay locked', async () => {
    const { admin, repo, mailer } = await harness();
    // A run with payout rows must never be hard-deleted, but can leave the active workflow.
    await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    expect((await admin.delete('/api/admin/payroll/runs/run-4')).status).toBe(400);
    const archived = await admin.post('/api/admin/payroll/runs/run-4/archive');
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe('archived');
    expect(repo.data.lines.filter((l) => l.runId === 'run-4')).toHaveLength(2);
    expect((await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F3|Opener|base'] })).body.error).toMatch(/archived/);
    expect((await admin.post('/api/admin/payroll/runs/run-4/advance')).body.error).toMatch(/archived/);
    expect((await admin.post('/api/admin/payroll/runs/run-4/reopen')).body.error).toMatch(/archived/);
    expect((await admin.post('/api/admin/payroll/runs/run-4/void').send({ repId: 'rep-julian-ribak' })).body.error).toMatch(/archived/);
    expect((await admin.post('/api/admin/payroll/runs/run-3/archive')).body.error).toMatch(/paid and locked/);
    expect((await admin.get('/api/admin/audit')).body.entries.some((e: { action: string }) => e.action === 'payroll.run.archive')).toBe(true);
    // Archived periods no longer reserve a date range, so an actual replacement can be opened.
    const replacement = await admin.post('/api/admin/payroll/runs').send({ start: '2026-09-01', end: '2026-09-15' });
    expect(replacement.status).toBe(201);
    expect((await admin.post(`/api/admin/payroll/runs/${replacement.body.id}/advance`)).body.status).toBe('approved');
    expect((await admin.post(`/api/admin/payroll/runs/${replacement.body.id}/archive`)).body.status).toBe('archived');

    // IDs remain immutable: replacing an archived deterministic ID never
    // collides with the archived record or its audit/ledger references.
    const first = await admin.post('/api/admin/payroll/runs').send({ start: '2026-10-01', end: '2026-10-15' });
    expect(first.body.id).toBe('run-2026-10-01');
    await admin.post(`/api/admin/payroll/runs/${first.body.id}/archive`);
    const second = await admin.post('/api/admin/payroll/runs').send({ start: '2026-10-01', end: '2026-10-15' });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe('run-2026-10-01-2');
  });

  it('conditionally refuses a payout commit after a run is archived', async () => {
    const { admin, repo, mailer } = await harness();
    const created = await admin.post('/api/admin/payroll/runs').send({ start: '2026-10-01', end: '2026-10-15' });
    await admin.post(`/api/admin/payroll/runs/${created.body.id}/archive`);
    // Models the final, transactional state check after a payout was planned:
    // no ledger mutation may occur if archival won the race.
    expect(await repo.commitPayoutForOpenRun(created.body.id, { lines: [], clawbackUpdates: [], dealsFullyPaid: [], paidAt: today })).toBe(false);
  });

  it('conditionally refuses a void commit when archive wins the race', async () => {
    const { admin, repo } = await harness();
    const created = await admin.post('/api/admin/payroll/runs').send({ start: '2026-10-01', end: '2026-10-15' });
    await admin.post(`/api/admin/payroll/runs/${created.body.id}/archive`);
    // A void plan may have been calculated before archival; its final write
    // still cannot append a reversing ledger row into the archived run.
    expect(await repo.commitPayoutForUnarchivedRun(created.body.id, { lines: [], clawbackUpdates: [], dealsFullyPaid: [], paidAt: today })).toBe(false);
  });
});

describe('voiding a payout', () => {
  it('reverses rows in a run, makes them payable again, and shows in the run and the rep history', async () => {
    const { admin, rep } = await harness();
    // Julian was paid F1|Opener|base (350) in run-3 with a 100 recovery. Void everything in run-3 for him.
    const res = await admin.post('/api/admin/payroll/runs/run-3/void').send({ repId: 'rep-julian-ribak' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: 2, reversed: 350, recoveriesReturned: 100 });
    const detail = (await admin.get('/api/admin/payroll/runs/run-3/reps/rep-julian-ribak')).body;
    expect(detail.paidInRun.filter((p: { voided: boolean }) => p.voided)).toHaveLength(2);
    expect(detail.paidInRun.filter((p: { role: string }) => p.role === 'Void')).toHaveLength(2);
    expect(detail.paidSummary).toMatchObject({ gross: 0, recovered: 0, voided: 350 });
    // the line is payable again and the wallet reflects it
    expect(detail.lines.map((l: { key: string }) => l.key)).toContain('F1|Opener|base');
    const wallet = (await rep.get('/api/me/wallet')).body;
    expect(wallet).toMatchObject({ paid: 0, cash: 0 });
    const history = (await rep.get('/api/me/payments')).body;
    expect(history.rows.filter((r: { voided: boolean }) => r.voided)).toHaveLength(2);
    expect(history.rows.some((r: { segmentLabel: string }) => r.segmentLabel === 'Voided')).toBe(true);
    // re-pay in run-4: the new row gets a #2 key, and the old one cannot be voided twice
    const pay = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F1|Opener|base'] });
    expect(pay.status).toBe(201);
    expect((await admin.post('/api/admin/payroll/runs/run-3/void').send({ repId: 'rep-julian-ribak', keys: ['F1|Opener|base'] })).status).toBe(400);
    expect((await admin.get('/api/admin/audit')).body.entries.some((e: { action: string }) => e.action === 'payroll.void')).toBe(true);
  });
});

describe('per-rep payroll detail', () => {
  it('lists payable lines with collection state, the clawback queue, and what was paid in the run', async () => {
    const { admin } = await harness();
    const res = await admin.get('/api/admin/payroll/runs/run-3/reps/rep-julian-ribak');
    expect(res.body.rep).toMatchObject({ id: 'rep-julian-ribak', name: 'Julian Ribak' });
    expect(res.body.lines).toEqual([expect.objectContaining({ key: 'F2|Opener|base', segmentLabel: 'Initial', business: 'F2 Business', role: 'Opener', rate: 0.35, amount: 700, lenderPaidLabel: 'Collected', collected: true, collectedKeys: ['F2|Opener|base'], uncollectedKeys: [], uncollectedAmount: 0, units: null })]);
    expect(res.body.payableUnits).toEqual([expect.objectContaining({ key: 'F2|Opener|base', dealId: 'F2', business: 'F2 Business', role: 'Opener', segmentLabel: 'Initial', amount: 700, collected: true, unit: null })]);
    expect(res.body.clawbacks).toEqual([{ id: 'cb-1', dealId: 'F1', business: 'F1 Business', date: '2026-08-15', remaining: 250 }]);
    expect(res.body.outstandingClawback).toBe(250);
    expect(res.body.paidInRun.map((p: { role: string; amount: number }) => [p.role, p.amount])).toEqual([['Opener', 350], ['Clawback recovery', -100]]);
    expect(res.body.paidSummary).toEqual({ gross: 350, recovered: 100, cash: 250, lineCount: 1, voided: 0 });
  });
  it('returns the domain-priced payable units for uneven schedules after earlier increments were paid', () => {
    const schedule = scheduleFor({ name: 'ROWAN', terms: 'weekly', weeks: 3 }, '2026-07-12', { amounts: [2_000, 7_000, 9_000] })!;
    const deal = { ...deals[1]!, id: 'F9', business: 'Uneven Business', commSchedule: { ...schedule, received: 2 } };
    // Increment 1 was committed earlier. The detail must expose only the true remaining
    // domain records, rather than divide the grouped balance into synthetic unit amounts.
    const context = { deals: [deal], lines: [{ ...lines[0]!, key: 'F9|Opener|base|u1', dealId: 'F9', amount: 70 }], clawbacks: [] };
    const units = payableUnitsFor(context, 'rep-julian-ribak');
    expect(units.map((unit) => [unit.key, unit.collected, unit.segmentLabel, unit.unit?.n, unit.unit?.label])).toEqual([
      ['F9|Opener|base|u2', true, 'Initial · Increment 2', 2, 'Increment 2'],
      ['F9|Opener|base|u3', false, 'Initial · Increment 3', 3, 'Increment 3'],
    ]);
    const collected = units.filter((unit) => unit.collected);
    const plan = planPayout(context, { repId: 'rep-julian-ribak', selectedKeys: collected.map((unit) => unit.key), runId: 'run-4', paidAt: '2026-09-02' });
    expect(collected.map((unit) => [unit.key, unit.amount])).toEqual(plan.lines.map((line) => [line.key, line.amount]));
    expect(plan.gross).toBe(collected.reduce((total, unit) => total + unit.amount, 0));
  });
  it('previews netting before commit', async () => {
    const { admin } = await harness();
    const res = await admin.post('/api/admin/payroll/preview').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    expect(res.body).toEqual({ gross: 700, withheld: 250, net: 450, outstandingClawback: 250 });
  });
});

describe('POST pay', () => {
  it('writes ledger rows and a recovery row, rolls up the clawback, stamps repPaid, and pins the rep', async () => {
    const { admin, repo, mailer } = await harness();
    const res = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ repId: 'rep-julian-ribak', runId: 'run-4', gross: 700, withheld: 250, net: 450, lines: 1, recoveries: 1, dealsFullyPaid: [], uncollectedDealIds: [] });
    expect(repo.data.lines.filter((l) => l.runId === 'run-4').map((l) => [l.role, l.amount, l.clawbackId])).toEqual([['Opener', 700, null], ['Clawback recovery', -250, 'cb-1']]);
    expect(repo.data.clawbacks[0]).toMatchObject({ recovered: 350, status: 'open' }); // Zach and Raymond still owe theirs
    expect(repo.audit.some((entry) => entry.action === 'payroll.pay' && entry.targetRepId === 'rep-julian-ribak')).toBe(true);
    expect(repo.audit.some((entry) => entry.action === 'mail.sent' && entry.detail?.why === 'payout recorded run-4|rep-julian-ribak|F2|Opener|base|cbrec|cb-1|run-4|rep-julian-ribak')).toBe(true);
    const receipt = mailer.sent.find((mail) => /^Payout recorded — /.test(mail.subject));
    expect(receipt).toMatchObject({ to: 'julian.ribak@greystoneus.com' });
    expect(receipt?.text).toMatch(/F2 Business — MBC \(1 selected line\)/);
    expect(receipt?.text).toMatch(/Gross commission: +\$700\.00/);
    expect(receipt?.text).toMatch(/Clawback withheld: +\$250\.00/);
    expect(receipt?.text).toMatch(/Net paid: +\$450\.00/);
    // Wallet agrees with the ledger the run just wrote.
    const wallet = await admin.get('/api/me/wallet').set('X-View-As', 'rep-julian-ribak');
    expect(wallet.body).toMatchObject({ earned: 1_050, paid: 1_050, cash: 700, held: 0, recovered: 350, balance: 0, payable: 0, owed: 0 });
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

  it('reloads changed deal economics before planning inside the payout lock', async () => {
    const { repo } = await harness();
    const originalPlan = repo.planPayoutForRun.bind(repo);
    let injected = false;
    repo.planPayoutForRun = async (runId, repId, allowed, plan) => {
      injected = true;
      await repo.updateDeal('F2', { openerRate: 0.5 });
      return originalPlan(runId, repId, allowed, plan);
    };

    const result = await paySelected(repo, {
      runId: 'run-4',
      repId: 'rep-julian-ribak',
      selectedKeys: ['F2|Opener|base'],
    }, 'rep-leor');
    expect(injected).toBe(true);
    expect(result.gross).toBe(1_000);
    expect(repo.data.lines.find((l) => l.runId === 'run-4' && l.role === 'Opener')?.amount).toBe(1_000);
  });

  it('serializes concurrent selections against one canonical payable balance', async () => {
    const { repo } = await harness();
    const base = repo.data.deals.find((deal) => deal.id === 'F2')!;
    const deal = (id: string, collected: number) => ({
      ...base,
      id,
      opportunityId: id,
      business: `${id} Business`,
      funded: 10_000,
      gross: 1_000,
      net: 1_000,
      commRate: 0.1,
      commCollected: collected,
      openerId: 'rep-julian-ribak',
      openerRate: 1,
      closerId: null,
      overrideId: null,
      repPaid: null,
      draws: [],
    });
    repo.data.deals.splice(0, repo.data.deals.length, deal('LIABILITY', 0), deal('PAY-A', 1_000), deal('PAY-B', 1_000));
    repo.data.lines.splice(0);
    repo.data.clawbacks.splice(0, repo.data.clawbacks.length, {
      ...clawbacks[0]!,
      id: 'cb-capacity',
      dealId: 'LIABILITY',
      amount: 1_000,
      recovered: 0,
      status: 'open',
    });

    const settled = await Promise.allSettled([
      paySelected(repo, { runId: 'run-4', repId: 'rep-julian-ribak', selectedKeys: ['PAY-A|Opener|base'] }, 'rep-leor'),
      paySelected(repo, { runId: 'run-4', repId: 'rep-julian-ribak', selectedKeys: ['PAY-B|Opener|base'] }, 'rep-leor'),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((result) => result.status === 'rejected');
    expect(loser).toMatchObject({ status: 'rejected', reason: { status: 400, message: expect.stringMatching(/balance changed.*refresh/i) } });
    expect(repo.data.lines.reduce((cash, row) => cash + row.amount, 0)).toBeLessThanOrEqual(1_000);
  });

  it('retains the opposite ordering: payout commits first, then an economics edit is rejected', async () => {
    const { repo } = await harness();
    await paySelected(repo, {
      runId: 'run-4',
      repId: 'rep-julian-ribak',
      selectedKeys: ['F2|Opener|base'],
    }, 'rep-leor');
    expect(repo.data.lines.some((l) => l.runId === 'run-4' && l.dealId === 'F2')).toBe(true);
    await expect(updateTerms(repo, 'F2', { amount: 3_000 }, 'rep-leor')).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/payouts in the ledger.*void them before changing its terms/i),
    });
  });
  it('does not send a payout receipt when payoutRecorded is off', async () => {
    const { admin, mailer } = await harness();
    await admin.put('/api/admin/settings/notifications').send({ payoutRecorded: false });
    const paid = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    expect(paid.status).toBe(201);
    expect(mailer.sent.filter((mail) => /^Payout recorded — /.test(mail.subject))).toHaveLength(0);
  });
  it('never sends for a refused stale payout, and a mail provider failure leaves a committed payout successful', async () => {
    const failingMailer: Mailer = {
      kind: 'memory', live: true,
      send: async () => { throw new Error('provider unavailable'); },
    };
    const { admin, repo } = await harness(failingMailer);
    const paid = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    expect(paid.status).toBe(201);
    expect(repo.data.lines.filter((line) => line.runId === 'run-4')).toHaveLength(2);
    expect(repo.audit.some((entry) => entry.action === 'mail.sent' && entry.detail?.ok === false && entry.detail?.error === 'provider unavailable')).toBe(true);
    const retry = await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    expect(retry.status).toBe(400);
    expect(repo.audit.filter((entry) => entry.action === 'mail.sent')).toHaveLength(1);
  });
  it('atomically claims a payout receipt so concurrent retries send exactly once', async () => {
    const { repo, mailer } = await harness();
    const plan: PayoutPlan = {
      runId: 'run-4', repId: 'rep-julian-ribak',
      lines: [{ key: 'F2|Opener|base', dealId: 'F2', segmentKey: 'base', role: 'Opener', repId: 'rep-julian-ribak', amount: 700, runId: 'run-4', clawbackId: null, paidAt: today }],
      recoveries: [], clawbackUpdates: [], gross: 700, withheld: 0, net: 700, dealsFullyPaid: [], uncollectedDealIds: [],
    };
    const deps = { repo, mailer, origin: 'https://portal.test', appName: 'Test' };
    const result = await Promise.all([
      notifyPayoutRecorded(deps, 'run-4', plan, 'rep-leor'),
      notifyPayoutRecorded(deps, 'run-4', plan, 'rep-leor'),
    ]);
    expect(result.filter((item) => item.sent)).toHaveLength(1);
    expect(result.filter((item) => item.duplicate)).toHaveLength(1);
    expect(mailer.sent.filter((mail) => /^Payout recorded — /.test(mail.subject))).toHaveLength(1);
  });
});

describe('increments paid to reps', () => {
  it('a consolidation pays per lender receipt; the row tracks 4/20 paid', async () => {
    const { admin } = await harness();
    // $100k consolidation on GFE (20 weekly increments), Julian opener 35%, no closer/override.
    const created = await admin.post('/api/admin/deals').send({ business: 'Consol Co', fundedDate: today, lender: 'GFE', product: 'CONSOLIDATION - UPFRONT COMM', amount: 100_000, termDays: 200, factor: 1.3, commRate: 10, openerId: 'rep-julian-ribak', openerRate: 35, referralPartner: null });
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
    // Funding progress rides the same increments: 100k planned in 20 × 5k, 4 out the door.
    expect(deal.segments[0].schedule.disbursement).toEqual({ planned: 100_000, perIncrement: 5_000, disbursed: 20_000, final: 100_000, count: 4, total: 20, stopped: false, uneven: false });
    // The merchant opts out after 4 → a 20k deal: funded, gross and the rep's share scale; the 4 paid units are all there is.
    const stopped = (await admin.post(`/api/admin/deals/${id}/collection`).send({ segmentKey: 'base', stopIncrements: true })).body;
    expect(stopped.funded).toBe(20_000);
    expect(stopped.gross).toBe(2_000);
    expect(stopped.increments).toMatchObject({ total: 4, lenderPaid: 4, repPaid: 4, disbursed: 20_000, planned: 100_000, stopped: true });
    expect(stopped.segments[0].schedule.planned).toMatchObject({ amount: 100_000, gross: 10_000, increments: 20 });
    expect(stopped.lenderPaidLabel).toBe('4/4 wks · opted out');
    expect(stopped.commissionStatus).toBe('YES - Paid In Full');
    const after = (await admin.get(`/api/admin/payroll/runs/run-4/reps/rep-julian-ribak`)).body;
    expect(after.lines.find((l: { dealId: string }) => l.dealId === id)).toBeUndefined();
    const rep = (await admin.get(`/api/me/deals/${id}`).set('X-View-As', 'rep-julian-ribak')).body;
    expect(rep).toMatchObject({ funded: 20_000, share: 700, paid: 700, owed: 0, disbursement: { disbursed: 20_000, planned: 100_000, count: 4, total: 4, stopped: true } });
    // reopening the plan puts the other 16 increments back
    const reopened = (await admin.post(`/api/admin/deals/${id}/collection`).send({ segmentKey: 'base', stopIncrements: false })).body;
    expect(reopened.funded).toBe(100_000);
    expect(reopened.increments).toMatchObject({ total: 20, stopped: false });
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
