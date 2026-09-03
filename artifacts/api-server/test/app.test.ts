import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { assertRepSafe } from '../src/scope.js';
import { memoryRepo } from './memory-repo.js';

const config = configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'test-secret', PORT: '0' });

function harness() {
  const repo = memoryRepo();
  const app = createApp(config, repo);
  const login = async (email: string) => {
    const agent = request.agent(app);
    const res = await agent.get('/auth/dev-login').query({ email });
    return { agent, res };
  };
  return { app, repo, login };
}

describe('auth', () => {
  it('rejects unauthenticated portal requests', async () => {
    const { app } = harness();
    expect((await request(app).get('/api/me/wallet')).status).toBe(401);
    expect((await request(app).get('/api/admin/reps')).status).toBe(401);
    expect((await request(app).get('/auth/me')).status).toBe(401);
  });
  it('signs in a provisioned rep by email and records the login', async () => {
    const { repo, login } = harness();
    const { agent, res } = await login('Julian.Ribak@greystoneus.com');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ repId: 'rep-julian-ribak', role: 'rep' });
    expect((await agent.get('/auth/me')).body).toMatchObject({ user: { repId: 'rep-julian-ribak' }, canViewAs: false });
    expect(repo.audit).toEqual([expect.objectContaining({ actorRepId: 'rep-julian-ribak', action: 'login' })]);
  });
  it('refuses unprovisioned and inactive accounts', async () => {
    const { login } = harness();
    expect((await login('stranger@example.com')).res.status).toBe(403);
    expect((await login('noah.levine@greystoneus.com')).res.status).toBe(403);
  });
  it('logout clears the session', async () => {
    const { login } = harness();
    const { agent } = await login('leor@greystoneus.com');
    expect((await agent.post('/auth/logout')).body).toMatchObject({ ok: true });
    expect((await agent.get('/auth/me')).status).toBe(401);
  });
  it('the dev login does not exist unless AUTH_MODE=dev', async () => {
    const app = createApp(configFromEnv({ SESSION_SECRET: 'x' }), memoryRepo());
    expect((await request(app).get('/auth/dev-login').query({ email: 'leor@greystoneus.com' })).status).toBe(404);
    expect(() => configFromEnv({ NODE_ENV: 'production', AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(40), OIDC_ISSUER: 'https://idp' })).toThrow(/not allowed in production/);
  });
  it('advertises sign-in methods publicly', async () => {
    const { app } = harness();
    expect((await request(app).get('/auth/methods')).body).toEqual({ oidc: false, devAuth: true, password: true });
  });
  it('OIDC login is unavailable when no issuer is configured', async () => {
    const { app } = harness();
    expect((await request(app).get('/auth/login')).status).toBe(503);
  });
});

describe('rep scoping is server-side', () => {
  it('a rep sees only their own deals, and every payload is rep-safe', async () => {
    const { login } = harness();
    const { agent } = await login('julian.ribak@greystoneus.com');
    const res = await agent.get('/api/me/deals');
    expect(res.status).toBe(200);
    expect(res.body.deals.map((d: { id: string }) => d.id)).toEqual(['F1', 'F2']);
    assertRepSafe(res.body);
    for (const path of ['/api/me', '/api/me/dashboard?from=2026-01-01&to=2026-09-02', '/api/me/renewals', '/api/me/payments', '/api/me/wallet', '/api/me/clawbacks', '/api/me/statements', '/api/me/leaderboard', '/api/me/deals/F1', '/api/me/monthly?months=2026-06,2026-07']) {
      const r = await agent.get(path);
      expect(r.status, path).toBe(200);
      assertRepSafe(r.body);
      expect(JSON.stringify(r.body), path).not.toMatch(/Zach Sanders|Raymond Amato|Leor/);
    }
  });
  it('dashboard rejects a reversed range', async () => {
    const { login } = harness();
    const { agent } = await login('julian.ribak@greystoneus.com');
    expect((await agent.get('/api/me/dashboard?from=2026-09-02&to=2026-01-01')).status).toBe(400);
  });
  it('a deal the rep is not on is a 404, not a leak', async () => {
    const { login } = harness();
    const { agent } = await login('julian.ribak@greystoneus.com');
    expect((await agent.get('/api/me/deals/F3')).status).toBe(404);
    expect((await agent.get('/api/me/deals/F999')).status).toBe(404);
  });
  it('a rep cannot view as anyone else, by header or query', async () => {
    const { login, repo } = harness();
    const { agent } = await login('julian.ribak@greystoneus.com');
    expect((await agent.get('/api/me/wallet').set('X-View-As', 'rep-zach-sanders')).status).toBe(403);
    expect((await agent.get('/api/me/wallet').query({ viewAs: 'rep-zach-sanders' })).status).toBe(403);
    expect(repo.audit.filter((a) => a.action === 'view-as')).toEqual([]);
  });
  it('admin endpoints are closed to reps', async () => {
    const { login } = harness();
    const { agent } = await login('julian.ribak@greystoneus.com');
    expect((await agent.get('/api/admin/reps')).status).toBe(403);
    expect((await agent.get('/api/admin/audit')).status).toBe(403);
    expect((await agent.get('/api/admin/reps/options?purpose=assign')).status).toBe(403);
  });
});

describe('admin View-as', () => {
  it('renders exactly the rep\'s own portal and is audit-logged per request', async () => {
    const { login, repo } = harness();
    const julian = (await login('julian.ribak@greystoneus.com')).agent;
    const admin = (await login('leor@greystoneus.com')).agent;
    for (const path of ['/api/me/wallet', '/api/me/deals', '/api/me/clawbacks', '/api/me/statements', '/api/me/payments', '/api/me/renewals', '/api/me/leaderboard']) {
      const own = await julian.get(path);
      const viewed = await admin.get(path).set('X-View-As', 'rep-julian-ribak');
      expect(viewed.status, path).toBe(200);
      expect(viewed.body, path).toEqual(own.body);
    }
    const me = await admin.get('/api/me').set('X-View-As', 'rep-julian-ribak');
    expect(me.body).toMatchObject({ rep: { id: 'rep-julian-ribak' }, viewAs: true, actor: { id: 'rep-leor', role: 'admin' } });
    const audit = repo.audit.filter((a) => a.action === 'view-as');
    expect(audit).toHaveLength(8);
    expect(audit[0]).toMatchObject({ actorRepId: 'rep-leor', targetRepId: 'rep-julian-ribak', path: '/api/me/wallet' });
    expect((await admin.get('/api/admin/audit')).body.entries.filter((e: { action: string }) => e.action === 'view-as')).toHaveLength(8);
  });
  it('admins can open an inactive rep to settle a final balance', async () => {
    const { login } = harness();
    const admin = (await login('leor@greystoneus.com')).agent;
    const res = await admin.get('/api/me').set('X-View-As', 'rep-noah-levine');
    expect(res.status).toBe(200);
    expect(res.body.rep).toMatchObject({ id: 'rep-noah-levine', active: false });
    expect((await admin.get('/api/admin/view-as/rep-noah-levine/check')).body).toMatchObject({ ok: true });
    expect((await admin.get('/api/admin/reps/options?purpose=view-as')).body.options).toContainEqual({ id: 'rep-noah-levine', label: 'Noah Levine (inactive)' });
    expect((await admin.get('/api/admin/reps/options?purpose=assign')).body.options.map((o: { id: string }) => o.id)).not.toContain('rep-noah-levine');
  });
  it('a manager can view their own team only', async () => {
    const { login } = harness();
    const mgr = (await login('raymond.amato@greystoneus.com')).agent;
    expect((await mgr.get('/api/me/wallet').set('X-View-As', 'rep-julian-ribak')).status).toBe(200);
    const denied = await mgr.get('/api/me/wallet').set('X-View-As', 'rep-zach-sanders');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/not on your team/);
    expect((await mgr.get('/api/admin/reps/options?purpose=view-as')).body.options.map((o: { id: string }) => o.id)).toEqual(['rep-raymond-amato', 'rep-julian-ribak', 'rep-noah-levine']);
    expect((await mgr.get('/api/admin/reps')).status).toBe(403);
  });
  it('an unknown target is a 403 with no audit row', async () => {
    const { login, repo } = harness();
    const admin = (await login('leor@greystoneus.com')).agent;
    expect((await admin.get('/api/me/wallet').set('X-View-As', 'rep-nobody')).status).toBe(403);
    expect(repo.audit.filter((a) => a.action === 'view-as')).toEqual([]);
  });
});

describe('admin roster', () => {
  it('reads every rep\'s money from repLedger', async () => {
    const { login } = harness();
    const admin = (await login('leor@greystoneus.com')).agent;
    const res = await admin.get('/api/admin/reps');
    const julian = res.body.reps.find((r: { id: string }) => r.id === 'rep-julian-ribak');
    expect(julian).toMatchObject({ name: 'Julian Ribak', team: 'Team Amato', earned: 1_050, paid: 350, held: 250, owed: 0, dealCount: 2 });
  });
});
