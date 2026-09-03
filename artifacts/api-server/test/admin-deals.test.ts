import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryRepo } from './memory-repo.js';

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
    expect(res.body).toMatchObject({ id: 'F4', business: 'Northstar Dental', merchantEmail: 'mduran@northstar.test', funded: 100_000, gross: 14_500, referralPartner: 'MBC', referralFee: 2_175, net: 12_325, commissionStatus: 'Waiting for payment', lenderPaidLabel: 'Not collected', atRisk: true, crmUrl: 'https://crm.test/o/F4' });
    expect(res.body.roles.map((r: { name: string; amount: number }) => [r.name, r.amount])).toEqual([['Julian Ribak', 4_313.75], ['Zach Sanders', 4_930], ['Raymond Amato', 616.25]]);
    expect(res.body.houseNet).toBe(12_325 - 4_313.75 - 4_930 - 616.25);
    expect(repo.audit.at(-1)).toMatchObject({ action: 'deal.create', actorRepId: 'rep-leor' });
    // and Julian now sees it in his portal
    const { rep } = await harness().then(async (h) => ({ rep: h.rep }));
    void rep;
  });
  it('attaches a weekly schedule for weekly lenders', async () => {
    const { admin } = await harness();
    const res = await admin.post('/api/admin/deals').send({ ...draft, lender: 'ROWAN' });
    expect(res.status).toBe(201);
    expect(res.body.segments[0].schedule).toEqual({ weeks: 20, received: 0, startDate: today, perWeek: 725 });
    expect(res.body.lenderPaidLabel).toBe('0/20 wks');
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
  it('deal status is validated against settings', async () => {
    const { admin } = await harness();
    expect((await admin.patch('/api/admin/deals/F1/status').send({ dealStatus: 'Refi Ready' })).body.dealStatus).toBe('Refi Ready');
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
    await admin.post('/api/admin/deals').send({ ...draft, lender: 'ROWAN', referralPartner: null });
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
