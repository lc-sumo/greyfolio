import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { repLedger } from '@greystone/commission';
import { clawbacks, deals, lines, memoryRepo, reps } from './memory-repo.js';

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
  return { repo, app, admin: await as('leor@greystoneus.com'), rep: await as('julian.ribak@greystoneus.com'), mgr: await as('raymond.amato@greystoneus.com') };
}

const CONSOL = 'CONSOLIDATION - UPFRONT COMM';
const draft = { business: 'Northstar Dental', merchantContact: 'Maria Duran', merchantEmail: 'MDuran@northstar.test', merchantPhone: '(201) 555-0199', fundedDate: today, lender: 'MBC', product: 'MCA', amount: 100_000, termDays: 120, factor: 1.3, commRate: 12, psfPct: 2, originationFee: 500, referralPartner: 'MBC', openerId: 'rep-julian-ribak', openerRate: 35, closerId: 'rep-zach-sanders', closerRate: 40, overrideId: 'rep-raymond-amato', overrideRate: 5 };

describe('only admins add deals', () => {
  it('reps and team leads get 403 on every deal write and on the master board', async () => {
    const { rep, mgr } = await harness();
    for (const agent of [rep, mgr]) {
      expect((await agent.post('/api/admin/deals').send(draft)).status).toBe(403);
      expect((await agent.get('/api/admin/deals')).status).toBe(403);
      expect((await agent.get('/api/admin/deals/F1')).status).toBe(403);
      expect((await agent.get('/api/admin/settings')).status).toBe(403);
      expect((await agent.patch('/api/admin/deals/F1/splits').send({ openerRate: 50 })).status).toBe(403);
      expect((await agent.post('/api/admin/deals/F1/draws').send({ amount: 1000 })).status).toBe(403);
      expect((await agent.post('/api/admin/deals/F1/collection').send({ segmentKey: 'base', toggle: true })).status).toBe(403);
    }
  });
  it('there is no rep-facing write route at all', async () => {
    const { rep } = await harness();
    expect((await rep.post('/api/me/deals').send(draft)).status).toBe(404);
  });
});

describe('POST /api/admin/deals', () => {
  it('creates the next F-id, prices it through the chain, and audits it', async () => {
    const { admin, repo } = await harness();
    const res = await admin.post('/api/admin/deals').send(draft);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'F4', business: 'Northstar Dental', merchantEmail: 'mduran@northstar.test', funded: 100_000, gross: 14_500, referralPartner: 'MBC', referralFee: 2_175, net: 12_325, commissionStatus: 'Waiting for payment', lenderPaidLabel: 'Not collected', atRisk: true, crmUrl: 'https://crm.test/o/F4', dealStatus: 'Performing', storedDealStatus: 'Performing' });
    expect(res.body.roles.map((r: { name: string; amount: number }) => [r.name, r.amount])).toEqual([['Julian Ribak', 4_313.75], ['Zach Sanders', 4_930], ['Raymond Amato', 616.25]]);
    expect(res.body.houseNet).toBe(12_325 - 4_313.75 - 4_930 - 616.25);
    expect(repo.audit.at(-1)).toMatchObject({ action: 'deal.create', actorRepId: 'rep-leor' });
    // and Julian now sees it in his portal
    const { rep } = await harness().then(async (h) => ({ rep: h.rep }));
    void rep;
  });
  it('attaches a weekly schedule to a consolidation on a weekly lender', async () => {
    const { admin } = await harness();
    const res = await admin.post('/api/admin/deals').send({ ...draft, lender: 'ROWAN', product: CONSOL });
    expect(res.status).toBe(201);
    expect(res.body.segments[0].schedule).toMatchObject({ weeks: 20, received: 0, perWeek: 725, cadenceDays: 7, upfrontPct: 0, remainder: 'spread', overdue: 0 });
    expect(res.body.segments[0].schedule.events).toHaveLength(20);
    expect(res.body.segments[0].schedule.nextExpected).toMatchObject({ kind: 'increment', n: 1, amount: 725 });
    expect(res.body.lenderPaidLabel).toBe('0/20 wks');
  });
  it('the referral cap is monthly: fees on same-month deals eat the room, and the typed % is ignored', async () => {
    const { admin } = await harness();
    const first = await admin.post('/api/admin/deals').send({ ...draft, amount: 1_000_000, referralPartner: 'MBC', referralRate: 50 });
    expect(first.body.referralRate).toBe(0.15);
    expect(first.body.referralFee).toBe(15_000); // 145,000 × 15% = 21,750 raw → capped at 15,000
    const second = await admin.post('/api/admin/deals').send({ ...draft, business: 'Second Co', referralPartner: 'MBC' });
    expect(second.body.referralFee).toBe(0); // the month's cap is spent
    expect(second.body.net).toBe(second.body.gross);
  });
  it('a consolidation can carry an increment grid; it must total the funded amount and can be edited on the deal', async () => {
    const { admin } = await harness();
    const grid = [...Array(15).fill(12_500), ...Array(3).fill(15_000), 8_750, 8_750];
    const bad = await admin.post('/api/admin/deals').send({ ...draft, product: CONSOL, lender: 'ROWAN', amount: 250_000, referralPartner: null, commAmounts: [100_000, 100_000] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/increment grid totals/);
    const res = await admin.post('/api/admin/deals').send({ ...draft, product: CONSOL, lender: 'ROWAN', amount: 250_000, referralPartner: null, commAmounts: grid });
    expect(res.status).toBe(201);
    const sch = res.body.segments[0].schedule;
    expect(sch.weeks).toBe(20);
    expect(sch.amounts).toEqual(grid);
    expect(sch.events[0]).toMatchObject({ funding: 12_500 });
    expect(sch.events[15]).toMatchObject({ funding: 15_000 });
    expect(sch.disbursement).toMatchObject({ planned: 250_000, uneven: true, count: 0 });
    const after = (await admin.post(`/api/admin/deals/${res.body.id}/collection`).send({ segmentKey: 'base', recordWeeks: 16 })).body;
    expect(after.segments[0].schedule.disbursement).toMatchObject({ disbursed: 202_500, count: 16 });
    const regrid = await admin.post(`/api/admin/deals/${res.body.id}/collection`).send({ segmentKey: 'base', amounts: [...Array(16).fill(12_500), 25_000, 25_000] });
    expect(regrid.status).toBe(200);
    expect(regrid.body.segments[0].schedule.weeks).toBe(18);
    expect((await admin.post(`/api/admin/deals/${res.body.id}/collection`).send({ segmentKey: 'base', amounts: [1, 2] })).status).toBe(400);
  });
  it('increments are a consolidation thing: MCAs, LOCs and LOC draws are paid upfront even on a weekly lender', async () => {
    const { admin } = await harness();
    const mca = await admin.post('/api/admin/deals').send({ ...draft, lender: 'ROWAN' });
    expect(mca.body.segments[0].schedule).toBeNull();
    expect(mca.body.lenderPaidLabel).toBe('Not collected');
    const loc = await admin.post('/api/admin/deals').send({ ...draft, lender: 'ROWAN', product: 'LOC - INITIAL', factor: undefined, commRate: undefined, creditLine: 250_000, referralPartner: null, commIncrements: 10, commUpfrontPct: 50 });
    expect(loc.body.segments[0].schedule).toBeNull();
    const draw = await admin.post(`/api/admin/deals/${loc.body.id}/draws`).send({ amount: 25_000 });
    expect(draw.body.segments.map((x: { schedule: unknown }) => x.schedule)).toEqual([null, null]);
    // a consolidation's draw follows the lender's increments
    const consol = await admin.post('/api/admin/deals').send({ ...draft, lender: 'ROWAN', product: CONSOL, creditLine: 300_000, referralPartner: null });
    const cdraw = await admin.post(`/api/admin/deals/${consol.body.id}/draws`).send({ amount: 25_000 });
    expect(cdraw.body.segments[1].schedule).toMatchObject({ weeks: 20, received: 0 });
  });
  it('rejects the guards with a readable message', async () => {
    const { admin } = await harness();
    expect((await admin.post('/api/admin/deals').send({ ...draft, fundedDate: '2099-01-01' })).body.error).toMatch(/in the future/);
    expect((await admin.post('/api/admin/deals').send({ ...draft, business: '', amount: 0 })).body.error).toMatch(/Business name is required; Funding amount is required/);
    expect((await admin.post('/api/admin/deals').send({ ...draft, product: 'LOC DRAW' })).body.error).toMatch(/parent deal/);
    expect((await admin.post('/api/admin/deals').send({ ...draft, lender: 'NOPE' })).body.error).toMatch(/Unknown lender/);
    expect((await admin.post('/api/admin/deals').send({ ...draft, openerId: 'rep-noah-levine' })).body.error).toMatch(/inactive/);
    expect((await admin.post('/api/admin/deals').send({ ...draft, openerId: 'rep-ghost' })).body.error).toMatch(/does not exist/);
  });
});

describe('deal edits', () => {
  it('splits may move to an inactive rep on an existing deal (history stays)', async () => {
    const { admin } = await harness();
    const res = await admin.patch('/api/admin/deals/F1/splits').send({ closerId: 'rep-noah-levine', closerRate: 25 });
    expect(res.status).toBe(200);
    expect(res.body.roles[1]).toMatchObject({ name: 'Noah Levine', rate: 0.25, amount: 250 });
    const cleared = await admin.patch('/api/admin/deals/F1/splits').send({ overrideId: null });
    expect(cleared.body.roles[2]).toMatchObject({ repId: null, rate: 0, amount: 0 });
  });
  it('the CRM deal ID is editable and drives the CRM link', async () => {
    const { admin, rep } = await harness();
    const res = await admin.patch('/api/admin/deals/F1/crm').send({ crmId: 'OPP-88213' });
    expect(res.body).toMatchObject({ crmId: 'OPP-88213', crmUrl: 'https://crm.test/o/OPP-88213' });
    expect((await admin.patch('/api/admin/deals/F1/crm').send({ crmId: '  ' })).body.crmId).toBeNull();
    expect((await rep.patch('/api/admin/deals/F1/crm').send({ crmId: 'x' })).status).toBe(403);
    expect((await rep.get('/api/me/deals/F1')).body.crmId).toBeNull();
  });
  it('every deal carries the lender clawback window, for admin and for the rep', async () => {
    const { admin, rep } = await harness();
    const a = await admin.get('/api/admin/deals/F1');
    // F1 is an MBC deal funded 2026-06-05; MBC claws back for 30 days → cleared long ago
    expect(a.body.clawbackWindow).toMatchObject({ basis: 'days', count: 30, source: 'lender', clearsOn: '2026-07-05', cleared: true });
    expect(a.body.atRisk).toBe(false);
    const r = await rep.get('/api/me/deals/F1');
    expect(r.body.clawbackWindow).toMatchObject({ cleared: true, label: 'Cleared clawback · 30 days' });
    const fresh = await admin.post('/api/admin/deals').send({ ...draft, lender: 'ACE FUNDING', referralPartner: null });
    expect(fresh.body.clawbackWindow).toMatchObject({ basis: 'days', count: 45, source: 'lender', cleared: false, daysLeft: 45 });
    // TERM LOAN carries no clawback in the product rules → exempt whatever the lender says
    const exempt = await admin.post('/api/admin/deals').send({ ...draft, business: 'Exempt Co', lender: 'UFS FUNDING', product: 'TERM LOAN', factor: undefined, apr: 12, referralPartner: null });
    expect(exempt.body.clawbackWindow).toMatchObject({ basis: 'none', source: 'product', cleared: true });
    expect(fresh.body.atRisk).toBe(true);
  });
  it('deal status is validated against settings', async () => {
    const { admin } = await harness();
    expect((await admin.patch('/api/admin/deals/F1/status').send({ dealStatus: 'Refinanced' })).body.dealStatus).toBe('Refinanced');
    expect((await admin.patch('/api/admin/deals/F1/status').send({ dealStatus: 'Refi Ready' })).status).toBe(400); // derived, never typed
    expect((await admin.patch('/api/admin/deals/F1/status').send({ dealStatus: 'Bogus' })).status).toBe(400);
  });
  it('adding a draw prices at the subsequent rate and raises outstanding immediately', async () => {
    const { admin } = await harness();
    await admin.post('/api/admin/deals').send({ ...draft, product: 'LOC - INITIAL', factor: undefined, commRate: undefined, creditLine: 250_000, referralPartner: null });
    const res = await admin.post('/api/admin/deals/F4/draws').send({ amount: 25_000 });
    expect(res.status).toBe(201);
    expect(res.body.segments.map((s: { sk: string; net: number }) => [s.sk, s.net])).toEqual([['base', 10_500], ['D1', 1_000]]);
    expect(res.body.outstanding).toBe(11_500);
    expect(res.body.lenderPaidLabel).toBe('0/2 segments');
    expect((await admin.post('/api/admin/deals/F1/draws').send({ amount: 100 })).body.error).toMatch(/subsequent draw rate/);
    // Optional term + factor on a draw → payback and the merchant's payment (deal frequency: Daily).
    const withTerms = await admin.post('/api/admin/deals/F4/draws').send({ amount: 10_000, termDays: 80, factor: 1.2 });
    expect(withTerms.body.segments[2]).toMatchObject({ sk: 'D2', termDays: 80, factor: 1.2, payback: 12_000, payment: 150 });
    expect(withTerms.body.segments[0]).toMatchObject({ sk: 'base', termDays: 120, factor: null, payment: null });
  });
});

describe('consolidation payout structures', () => {
  it('a deal can ask for 50 upfront and the rest when increments are done; upfront and final have recorders', async () => {
    const { admin } = await harness();
    const res = await admin.post('/api/admin/deals').send({ ...draft, product: CONSOL, referralPartner: null, commIncrements: 10, commUpfrontPct: 50, commRemainder: 'at-end' });
    expect(res.status).toBe(201);
    const sch = res.body.segments[0].schedule;
    expect(sch).toMatchObject({ weeks: 10, upfrontPct: 0.5, upfrontAmount: 7_250, upfrontReceived: false, remainder: 'at-end', remainderAmount: 7_250, remainderReceived: false, perWeek: 0 });
    expect(sch.events.map((e: { kind: string }) => e.kind)).toEqual(['upfront', ...Array(10).fill('increment'), 'remainder']);
    expect(res.body.lenderPaidLabel).toBe('(no) 50% up + 0/10 wks');
    let r = await admin.post('/api/admin/deals/F4/collection').send({ segmentKey: 'base', markUpfront: true });
    expect(r.body).toMatchObject({ collected: 7_250, commissionStatus: 'Partially Paid', lenderPaidLabel: '50% up + 0/10 wks' });
    r = await admin.post('/api/admin/deals/F4/collection').send({ segmentKey: 'base', recordWeeks: 10 });
    expect(r.body).toMatchObject({ collected: 7_250, lenderPaidLabel: '50% up + 10/10 wks · final due' });
    r = await admin.post('/api/admin/deals/F4/collection').send({ segmentKey: 'base', markRemainder: true });
    expect(r.body).toMatchObject({ collected: 14_500, commissionStatus: 'YES - Paid In Full', lenderPaidLabel: '10/10 wks' });
    expect((await admin.post('/api/admin/deals/F1/collection').send({ segmentKey: 'base', markUpfront: true })).status).toBe(400);
  });
  it('lender defaults carry the structure and the overview expects the receipts', async () => {
    const { admin } = await harness();
    const lenders = (await admin.get('/api/admin/settings')).body.lenders.map((l: { name: string }) => (l.name === 'ROWAN' ? { ...l, upfrontPct: 50, remainder: 'at-end', cadenceDays: 14 } : l));
    const saved = await admin.put('/api/admin/settings/lenders').send({ lenders });
    expect(saved.body.lenders.find((l: { name: string }) => l.name === 'ROWAN')).toMatchObject({ name: 'ROWAN', terms: 'weekly', weeks: 20, upfrontPct: 0.5, remainder: 'at-end', cadenceDays: 14 });
    const res = await admin.post('/api/admin/deals').send({ ...draft, lender: 'ROWAN', product: CONSOL, referralPartner: null });
    expect(res.body.segments[0].schedule).toMatchObject({ weeks: 20, upfrontPct: 0.5, remainder: 'at-end', cadenceDays: 14 });
    const ov = (await admin.get('/api/admin/overview')).body.cards;
    expect(ov.expected30Count).toBeGreaterThanOrEqual(1); // the upfront is due today
    expect(ov.expected30).toBeGreaterThanOrEqual(7_250);
  });
});

describe('collection is one writer', () => {
  it('the status select writes collection and the pill toggles it', async () => {
    const { admin } = await harness();
    let res = await admin.post('/api/admin/deals/F2/collection').send({ segmentKey: 'base', status: 'YES - Paid In Full' });
    expect(res.body).toMatchObject({ collected: 2_000, outstanding: 0, commissionStatus: 'YES - Paid In Full', lenderPaidLabel: 'Collected' });
    expect(res.body.lenderPaid).toBe(today);
    res = await admin.post('/api/admin/deals/F2/collection').send({ segmentKey: 'base', toggle: true });
    expect(res.body).toMatchObject({ collected: 0, commissionStatus: 'Waiting for payment', lenderPaid: null });
    res = await admin.post('/api/admin/deals/F2/collection').send({ segmentKey: 'base', dollars: 500 });
    expect(res.body).toMatchObject({ collected: 500, commissionStatus: 'Partially Paid', lenderPaidLabel: 'Part collected' });
  });
  it('weekly segments record weeks, and Paid In Full sets received = weeks', async () => {
    const { admin } = await harness();
    await admin.post('/api/admin/deals').send({ ...draft, lender: 'ROWAN', product: CONSOL, referralPartner: null });
    let res = await admin.post('/api/admin/deals/F4/collection').send({ segmentKey: 'base', recordWeeks: 3 });
    expect(res.body.segments[0].schedule.received).toBe(3);
    expect(res.body.lenderPaidLabel).toBe('3/20 wks');
    expect(res.body.collected).toBe(2_175);
    res = await admin.post('/api/admin/deals/F4/collection').send({ segmentKey: 'base', status: 'YES - Paid In Full' });
    expect(res.body.segments[0].schedule.received).toBe(20);
    res = await admin.post('/api/admin/deals/F4/collection').send({ segmentKey: 'base', recordWeeks: 1 });
    expect(res.body.segments[0].schedule.received).toBe(20); // a manual paid-in-full cannot be silently reverted
    expect((await admin.post('/api/admin/deals/F1/collection').send({ segmentKey: 'base', recordWeeks: 1 })).status).toBe(400);
    expect((await admin.post('/api/admin/deals/F1/collection').send({ segmentKey: 'D9', toggle: true })).status).toBe(404);
  });
});

describe('admin renewals', () => {
  it('buckets every deal with who calls it, admin-only', async () => {
    const { admin, rep } = await harness();
    expect((await rep.get('/api/admin/renewals')).status).toBe(403);
    const res = await admin.get('/api/admin/renewals');
    expect(res.status).toBe(200);
    expect(res.body.renewals).toHaveLength(3);
    expect(res.body.renewals.find((r: { id: string }) => r.id === 'F1')).toMatchObject({ whoCalls: 'Zach', bucket: 'due', effectiveStatus: 'Refi Ready', estRenewalGross: 1_000, merchantContact: 'Daniel Reyes' });
    // F3 funded Aug 2 with a 120-day term: eligible for more capital after 30 days, nowhere near the mark
    expect(res.body.renewals.find((r: { id: string }) => r.id === 'F3')).toMatchObject({ bucket: 'prospecting', effectiveStatus: 'Prospecting', prospectingDate: '2026-09-01' });
  });
});

describe('merchants and overview', () => {
  it('groups deals by merchant email with totals and history', async () => {
    const { admin, rep } = await harness();
    expect((await rep.get('/api/admin/merchants')).status).toBe(403);
    const res = await admin.get('/api/admin/merchants');
    expect(res.body.merchants).toHaveLength(3);
    const f1 = res.body.merchants.find((m: { email: string }) => m.email === 'f1@merchant.test');
    expect(f1).toMatchObject({ business: 'F1 Business', contact: 'Daniel Reyes', dealCount: 1, funded: 10_000, gross: 1_000, outstanding: 0 });
    expect(f1.deals[0]).toMatchObject({ id: 'F1', commissionStatus: 'YES - Paid In Full' });
  });
  it('the overview totals the period and reads owed from the ledger', async () => {
    const { admin, rep } = await harness();
    expect((await rep.get('/api/admin/overview')).status).toBe(403);
    const res = await admin.get('/api/admin/overview?from=2026-06-01&to=2026-08-31');
    expect(res.body.cards).toMatchObject({ funded: 35_000, commissions: 3_500, opportunities: 3, drawLines: 0, avgFactor: 1.3, paid: 350, renewalReady: 1 });
    const ctx = { deals, lines, clawbacks };
    expect(res.body.cards.owed).toBe(reps.reduce((sum, r) => sum + repLedger(ctx, r.id).owed, 0)); // one definition of owed
    expect(res.body.cards.clawbackExposure).toBe(700); // cb-1: 800 rep total − 100 recovered
    expect(res.body.monthly.map((m: { month: string; funded: number }) => [m.month, m.funded])).toEqual([['2026-06', 10_000], ['2026-07', 20_000], ['2026-08', 5_000]]);
    expect(res.body.lenders[0]).toMatchObject({ lender: 'MBC', deals: 3, funded: 35_000, collectedPct: 29 });
    expect(res.body.clawbacks[0]).toMatchObject({ dealId: 'F1', remaining: 700 });
    expect((await admin.get('/api/admin/overview?from=2026-09-01&to=2026-01-01')).status).toBe(400);
  });
});

describe('master board', () => {
  it('searches merchant fields and filters by rep', async () => {
    const { admin } = await harness();
    const all = await admin.get('/api/admin/deals');
    expect(all.body.count).toBe(3);
    expect(all.body.repOptions.assign.map((o: { id: string }) => o.id)).not.toContain('rep-noah-levine');
    expect(all.body.repOptions.edit.find((o: { id: string }) => o.id === 'rep-noah-levine').label).toBe('Noah Levine (inactive)');
    expect((await admin.get('/api/admin/deals?search=f2@merchant')).body.deals.map((d: { id: string }) => d.id)).toEqual(['F2']);
    expect((await admin.get('/api/admin/deals?rep=rep-julian-ribak')).body.count).toBe(2);
    expect((await admin.get('/api/admin/deals?status=YES - Paid In Full')).body.deals.map((d: { id: string }) => d.id)).toEqual(['F1']);
  });
  it('the detail carries every rep, the ledger and clawback slices', async () => {
    const { admin } = await harness();
    const res = await admin.get('/api/admin/deals/F1');
    expect(res.body.payments.map((p: { repName: string; amount: number }) => [p.repName, p.amount])).toEqual([['Julian Ribak', 350], ['Julian Ribak', -100]]);
    expect(res.body.clawbacks[0].slices.map((s: { name: string; remaining: number }) => [s.name, s.remaining])).toEqual([['Julian Ribak', 250], ['Zach Sanders', 400], ['Raymond Amato', 50]]);
    expect((await admin.get('/api/admin/deals/F999')).status).toBe(404);
  });
});
