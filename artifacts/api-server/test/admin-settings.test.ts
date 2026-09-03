import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryRepo } from './memory-repo.js';

const config = configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'test-secret', PORT: '0' });

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

describe('settings are admin-only', () => {
  it('reps and team leads get 403', async () => {
    const { rep, mgr } = await harness();
    for (const a of [rep, mgr]) {
      expect((await a.put('/api/admin/settings/lenders').send({ lenders: [] })).status).toBe(403);
      expect((await a.post('/api/admin/teams').send({ name: 'X' })).status).toBe(403);
      expect((await a.patch('/api/admin/reps/rep-julian-ribak').send({ openerRate: 90 })).status).toBe(403);
      expect((await a.get('/api/admin/settings/usage')).status).toBe(403);
    }
  });
});

describe('lists with in-use guards', () => {
  it('usage counts what deals reference', async () => {
    const { admin } = await harness();
    const u = (await admin.get('/api/admin/settings/usage')).body;
    expect(u.lenders).toEqual({ MBC: 3 });
    expect(u.partners).toEqual({ 'HUB TRACKER': 1 });
    expect(u.products).toEqual({ MCA: 3 });
    expect(u.teams).toEqual({ 'team-a': 3, 'team-b': 1 });
  });
  it('lenders: add and edit freely, refuse removing one in use', async () => {
    const { admin, repo } = await harness();
    const current = (await admin.get('/api/admin/settings')).body.lenders;
    const next = [...current.map((l: { name: string }) => (l.name === 'ROWAN' ? { ...l, weeks: 24 } : l)), { name: 'NEW CAPITAL', terms: 'weekly', weeks: 10 }];
    const res = await admin.put('/api/admin/settings/lenders').send({ lenders: next });
    expect(res.status).toBe(200);
    expect(res.body.lenders.find((l: { name: string }) => l.name === 'ROWAN').weeks).toBe(24);
    expect(res.body.lenders.at(-1)).toEqual({ name: 'NEW CAPITAL', terms: 'weekly', weeks: 10 });
    expect(repo.audit.at(-1)).toMatchObject({ action: 'settings.update' });
    const removeMbc = await admin.put('/api/admin/settings/lenders').send({ lenders: next.filter((l: { name: string }) => l.name !== 'MBC') });
    expect(removeMbc.status).toBe(400);
    expect(removeMbc.body.error).toMatch(/MBC \(3 deals\)/);
    expect((await admin.put('/api/admin/settings/lenders').send({ lenders: [...next, { name: 'Bad', terms: 'weekly', weeks: 0 }] })).body.error).toMatch(/week count/);
    expect((await admin.put('/api/admin/settings/lenders').send({ lenders: [...next, { name: 'MBC', terms: 'upfront' }] })).body.error).toMatch(/Duplicate/);
  });
  it('lenders: increments follow the products a lender funds, and the clawback policy is saved', async () => {
    const { admin } = await harness();
    const current = (await admin.get('/api/admin/settings')).body.lenders;
    const next = [
      ...current,
      // an MCA-only lender cannot pay in increments however it is typed
      { name: 'MCA HOUSE', terms: 'weekly', weeks: 10, products: ['MCA', 'TERM LOAN'], clawback: { basis: 'days', count: 45 } },
      // a consolidation lender does, with its structure
      { name: 'CONSOL CO', terms: 'weekly', weeks: 8, upfrontPct: 50, remainder: 'at-end', products: ['CONSOLIDATION - UPFRONT COMM'], clawback: { basis: 'payments', count: 10, note: 'first 10 payments' } },
      { name: 'NO CLAW', products: ['EQUIPMENT', 'Bogus Product'], clawback: { basis: 'none' } },
    ];
    const res = await admin.put('/api/admin/settings/lenders').send({ lenders: next });
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.lenders.map((l: { name: string }) => [l.name, l]));
    expect(by['MCA HOUSE']).toEqual({ name: 'MCA HOUSE', terms: 'upfront', weeks: 0, products: ['MCA', 'TERM LOAN'], clawback: { basis: 'days', count: 45 } });
    expect(by['CONSOL CO']).toEqual({ name: 'CONSOL CO', terms: 'weekly', weeks: 8, upfrontPct: 0.5, remainder: 'at-end', products: ['CONSOLIDATION - UPFRONT COMM'], clawback: { basis: 'payments', count: 10, note: 'first 10 payments' } });
    expect(by['NO CLAW']).toEqual({ name: 'NO CLAW', terms: 'upfront', weeks: 0, products: ['EQUIPMENT'], clawback: { basis: 'none', count: 0 } });
    expect((await admin.put('/api/admin/settings/lenders').send({ lenders: [...current, { name: 'X', clawback: { basis: 'days', count: 0 } }] })).body.error).toMatch(/day count/);
  });
  it('partners: percent input normalises, blank cap = uncapped, in-use guard', async () => {
    const { admin } = await harness();
    const current = (await admin.get('/api/admin/settings')).body.partners;
    const res = await admin.put('/api/admin/settings/partners').send({ partners: [...current, { name: 'ACME REF', pct: 12.5, monthlyCap: '' }] });
    expect(res.body.partners.at(-1)).toEqual({ name: 'ACME REF', pct: 0.125, monthlyCap: null });
    expect((await admin.put('/api/admin/settings/partners').send({ partners: current.filter((p: { name: string }) => p.name !== 'HUB TRACKER') })).body.error).toMatch(/HUB TRACKER \(1 deal\)/);
  });
  it('products: draw basis forces parent, multi-draw keeps draw %s, in-use guard', async () => {
    const { admin } = await harness();
    const current = (await admin.get('/api/admin/settings')).body.products;
    const res = await admin.put('/api/admin/settings/products').send({ products: [...current, { name: 'BRIDGE DRAW', basis: 'draw', comm: 3 }, { name: 'MEGA LOC', basis: 'funded', term: true, comm: 7, multiDraw: true, drawInitial: 7, drawSubsequent: 3.5 }] });
    expect(res.status).toBe(200);
    expect(res.body.products.find((p: { name: string }) => p.name === 'BRIDGE DRAW')).toMatchObject({ basis: 'draw', parent: true, comm: 0.03, drawInitial: null });
    expect(res.body.products.find((p: { name: string }) => p.name === 'MEGA LOC')).toMatchObject({ multiDraw: true, drawInitial: 0.07, drawSubsequent: 0.035 });
    expect((await admin.put('/api/admin/settings/products').send({ products: current.filter((p: { name: string }) => p.name !== 'MCA') })).body.error).toMatch(/MCA \(3 deals\)/);
  });
  it('thresholds and CRM validate and take effect', async () => {
    const { admin } = await harness();
    const t = await admin.put('/api/admin/settings/thresholds').send({ clawbackWindowDays: 45, paymentOverdueDays: 21, renewalMark: 50, additionalCapitalAfterDays: 30 });
    expect(t.body.thresholds).toEqual({ clawbackWindowDays: 45, paymentOverdueDays: 21, renewalMark: 0.5, additionalCapitalAfterDays: 30 });
    expect((await admin.get('/api/admin/settings')).body.thresholds.renewalMark).toBe(0.5);
    expect((await admin.put('/api/admin/settings/thresholds').send({ clawbackWindowDays: 45, paymentOverdueDays: 21, renewalMark: 0, additionalCapitalAfterDays: 30 })).status).toBe(400);
    expect((await admin.put('/api/admin/settings/crm').send({ urlTemplate: 'ftp://nope/{id}' })).status).toBe(400);
    const crm = await admin.put('/api/admin/settings/crm').send({ urlTemplate: 'https://crm.example.com/opportunity/{id}' });
    expect(crm.body.crm.urlTemplate).toBe('https://crm.example.com/opportunity/{id}');
    expect((await admin.get('/api/admin/deals/F1')).body.crmUrl).toBe('https://crm.example.com/opportunity/F1');
    expect((await admin.put('/api/admin/settings/crm').send({ urlTemplate: '' })).body.crm.urlTemplate).toBe('');
    expect((await admin.get('/api/admin/deals/F1')).body.crmUrl).toBe('');
  });
});

describe('teams', () => {
  it('creates a team with a leader, who joins it and becomes a team lead', async () => {
    const { admin, repo } = await harness();
    const res = await admin.post('/api/admin/teams').send({ name: 'Team Ribak', leaderRepId: 'rep-julian-ribak', overrideRate: 7.5 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'team-team-ribak', name: 'Team Ribak', leaderRepId: 'rep-julian-ribak', overrideRate: 0.075 });
    const julian = repo.data.reps.find((r) => r.id === 'rep-julian-ribak')!;
    expect(julian).toMatchObject({ teamId: 'team-team-ribak', role: 'manager' });
    expect((await admin.post('/api/admin/teams').send({ name: 'team ribak' })).body.error).toMatch(/already exists/);
    expect((await admin.post('/api/admin/teams').send({ name: 'Ghosts', leaderRepId: 'rep-ghost' })).status).toBe(400);
  });
  it('edits name, leader and override %, and refuses deletion while staffed', async () => {
    const { admin, repo } = await harness();
    const res = await admin.patch('/api/admin/teams/team-b').send({ name: 'Team Sanders West', overrideRate: 6, leaderRepId: 'rep-zach-sanders' });
    expect(res.body).toMatchObject({ name: 'Team Sanders West', overrideRate: 0.06, leaderRepId: 'rep-zach-sanders' });
    expect(repo.data.reps.find((r) => r.id === 'rep-zach-sanders')?.role).toBe('manager');
    const del = await admin.delete('/api/admin/teams/team-b');
    expect(del.status).toBe(400);
    expect(del.body.error).toMatch(/still has 1 rep assigned/);
    await admin.patch('/api/admin/reps/rep-zach-sanders').send({ teamId: 'team-a' });
    expect((await admin.delete('/api/admin/teams/team-b')).status).toBe(204);
    expect(repo.data.teams.some((t) => t.id === 'team-b')).toBe(false);
    expect((await admin.delete('/api/admin/teams/team-b')).status).toBe(404);
  });
});

describe('reps', () => {
  it('creates a rep who can then sign in', async () => {
    const { admin, repo } = await harness();
    const res = await admin.post('/api/admin/reps').send({ name: 'Levi Forgash', email: 'Levi.Forgash@greystoneus.com', teamId: 'team-a', openerRate: 20, closerRate: 20 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'rep-levi-forgash', email: 'levi.forgash@greystoneus.com', role: 'rep', teamId: 'team-a', openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: true });
    const app = createApp(config, repo);
    const login = await request.agent(app).get('/auth/dev-login').query({ email: 'levi.forgash@greystoneus.com' });
    expect(login.status).toBe(200);
    expect((await admin.post('/api/admin/reps').send({ name: 'Dup', email: 'levi.forgash@greystoneus.com' })).body.error).toMatch(/already provisioned/);
    expect((await admin.post('/api/admin/reps').send({ name: 'No Mail', email: 'nope' })).status).toBe(400);
  });
  it('edits rates, team, access and active; guards the last admin and self', async () => {
    const { admin } = await harness();
    const res = await admin.patch('/api/admin/reps/rep-julian-ribak').send({ openerRate: 40, closerRate: 35, overrideRate: '', teamId: 'team-b', role: 'manager' });
    expect(res.body).toMatchObject({ openerRate: 0.4, closerRate: 0.35, overrideRate: null, teamId: 'team-b', role: 'manager' });
    expect((await admin.patch('/api/admin/reps/rep-julian-ribak').send({ active: false })).body.active).toBe(false);
    // inactive reps drop out of assignment but stay on existing deals
    const board = (await admin.get('/api/admin/deals')).body;
    expect(board.repOptions.assign.map((o: { id: string }) => o.id)).not.toContain('rep-julian-ribak');
    expect(board.deals.find((d: { id: string }) => d.id === 'F1').roles[0]).toMatchObject({ repId: 'rep-julian-ribak', name: 'Julian Ribak' });
    expect((await admin.patch('/api/admin/reps/rep-leor').send({ role: 'rep' })).body.error).toMatch(/last active admin|yourself/);
    expect((await admin.patch('/api/admin/reps/rep-leor').send({ active: false })).body.error).toMatch(/last active admin|yourself/);
    expect((await admin.patch('/api/admin/reps/rep-julian-ribak').send({ role: 'owner' })).status).toBe(400);
    expect((await admin.patch('/api/admin/reps/rep-julian-ribak').send({ email: 'zach.sanders@greystoneus.com' })).body.error).toMatch(/belongs to Zach Sanders/);
  });
});
