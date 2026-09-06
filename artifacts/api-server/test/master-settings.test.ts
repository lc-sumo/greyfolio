import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { totpCode } from '../src/auth/totp.js';
import { memoryMailer } from '../src/services/mail.js';
import { renewalDigest } from '../src/services/notify.js';
import { memoryRepo } from './memory-repo.js';

async function harness(env: Record<string, string> = {}) {
  const repo = memoryRepo();
  const mailer = memoryMailer();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test', ...env }), repo, { mailer });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  return { repo, app, admin, mailer };
}

describe('first-run setup', () => {
  it('offers setup only while nobody has a password, takes the roster admin, and closes itself', async () => {
    const repo = memoryRepo();
    const app = createApp(configFromEnv({ SESSION_SECRET: 'x'.repeat(32) }), repo, { mailer: memoryMailer() });
    const methods = (await request(app).get('/auth/methods')).body;
    expect(methods).toMatchObject({ oidc: false, devAuth: false, password: true, setup: true });
    expect(methods.branding.company).toBe('Greystone Merchant Partners');
    // Only an active admin from the roster can claim the first password.
    expect((await request(app).post('/auth/setup').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' })).status).toBe(403);
    expect((await request(app).post('/auth/setup').send({ email: 'leor@greystoneus.com', password: 'short' })).status).toBe(400);
    const me = request.agent(app);
    const done = await me.post('/auth/setup').send({ email: 'leor@greystoneus.com', password: 'Harbor-Cedar-1234' });
    expect(done.status).toBe(201);
    expect(done.body.user.role).toBe('admin');
    expect((await me.get('/api/admin/settings')).status).toBe(200);
    // Closed for good: a second call is refused and the login screen stops offering it.
    expect((await request(app).post('/auth/setup').send({ email: 'leor@greystoneus.com', password: 'Maple-River-5678' })).status).toBe(403);
    expect((await request(app).get('/auth/methods')).body.setup).toBe(false);
    expect((await request(app).post('/auth/password-login').send({ email: 'leor@greystoneus.com', password: 'Harbor-Cedar-1234' })).body.ok).toBe(true);
  });
  it('is never offered when SSO is configured or passwords are off', async () => {
    const off = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), AUTH_PASSWORD: 'off' }), memoryRepo());
    expect((await request(off).get('/auth/methods')).body.setup).toBe(false);
    expect((await request(off).post('/auth/setup').send({ email: 'leor@greystoneus.com', password: 'Harbor-Cedar-1234' })).status).toBe(404);
  });
});

describe('Settings › Portal', () => {
  it('saves names and support email, and the login screen and /auth/me carry them', async () => {
    const { app, admin } = await harness();
    expect((await admin.put('/api/admin/settings/portal').send({ company: 'Greystone', portal: 'Rep portal', supportEmail: 'not-an-email' })).status).toBe(400);
    const saved = await admin.put('/api/admin/settings/portal').send({ company: '  Greystone  ', portal: 'Rep portal', supportEmail: 'Help@GreystoneUS.com' });
    expect(saved.body.portal).toEqual({ company: 'Greystone', portal: 'Rep portal', supportEmail: 'help@greystoneus.com' });
    expect((await request(app).get('/auth/methods')).body.branding).toEqual({ company: 'Greystone', portal: 'Rep portal', supportEmail: 'help@greystoneus.com' });
    expect((await admin.get('/auth/me')).body.branding.portal).toBe('Rep portal');
    // Blank names fall back to the defaults rather than an empty header.
    expect((await admin.put('/api/admin/settings/portal').send({ company: '', portal: '' })).body.portal.company).toBe('Greystone Merchant Partners');
    const audit = (await admin.get('/api/admin/audit').query({ action: 'settings.update' })).body;
    expect(audit.entries.some((e: { path: string }) => e.path === '/api/admin/settings/portal')).toBe(true);
  });
  it('edits the dropdown lists but keeps the statuses the portal sets itself', async () => {
    const { admin } = await harness();
    expect((await admin.put('/api/admin/settings/lists').send({ frequencies: [] })).status).toBe(400);
    expect((await admin.put('/api/admin/settings/lists').send({ dealStatuses: ['Performing', 'Prospecting'] })).status).toBe(400);
    const r = await admin.put('/api/admin/settings/lists').send({ frequencies: ['Daily', 'Weekly', ' Weekly ', 'Bi-weekly'], dealStatuses: ['Performing', 'Prospecting', 'Refi Ready', 'Watch list'] });
    expect(r.body.lists.frequencies).toEqual(['Daily', 'Weekly', 'Bi-weekly']);
    expect(r.body.lists.dealStatuses).toContain('Watch list');
    expect((await admin.get('/api/admin/settings')).body.lists.frequencies).toEqual(['Daily', 'Weekly', 'Bi-weekly']);
  });
  it('turns emails off per kind, and the senders honour it', async () => {
    const { admin, repo, mailer } = await harness();
    expect((await admin.put('/api/admin/settings/notifications').send({ digestHourUtc: 25 })).status).toBe(400);
    const r = await admin.put('/api/admin/settings/notifications').send({ statements: true, clawbacks: false, renewalDigest: false, repQuestions: true, digestHourUtc: 9 });
    expect(r.body.notifications).toEqual({ statements: true, clawbacks: false, renewalDigest: false, repQuestions: true, digestHourUtc: 9, playbookHourUtc: 12 });
    const cb = await admin.post('/api/admin/deals/F2/clawbacks').send({ amount: 500, date: '2026-08-01', reason: 'Merchant defaulted' });
    expect(cb.status).toBe(201);
    expect(cb.body.notified).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    expect(await renewalDigest({ repo, mailer, origin: 'https://portal.test', appName: 'Test' }, '2026-09-03')).toEqual({ sent: 0, deals: 0 });
    // Names from Settings › Portal sign the emails that are still on.
    await admin.put('/api/admin/settings/portal').send({ company: 'Greystone', portal: 'Rep portal' });
    await admin.put('/api/admin/settings/notifications').send({ renewalDigest: true, digestHourUtc: 9 });
    const digest = await renewalDigest({ repo, mailer, origin: 'https://portal.test', appName: 'Test' }, '2026-09-03');
    expect(digest.sent).toBe(1);
    expect(mailer.sent.at(-1)!.text).toMatch(/— Greystone Rep portal$/);
  });
});

describe('required two-factor for admins', () => {
  it('cannot be switched on by an admin who is not enrolled, then gates every admin route except enrolment', async () => {
    const { app, admin } = await harness();
    expect((await admin.put('/api/admin/settings/security').send({ requireTotpForAdmins: true })).status).toBe(400);
    // Enrol the switching admin first.
    const setup = await admin.post('/api/me/totp/setup');
    await admin.post('/api/me/totp/enable').send({ code: totpCode(setup.body.secret) });
    const on = await admin.put('/api/admin/settings/security').send({ requireTotpForAdmins: true });
    expect(on.body.security).toEqual({ requireTotpForAdmins: true, idleMinutes: 120, totpRememberDays: 7 });
    expect((await admin.get('/auth/me')).body.mustEnrollTotp).toBe(false);
    // A second admin without two-factor is held at the enrolment screen.
    expect((await admin.patch('/api/admin/reps/rep-raymond-amato').send({ role: 'admin' })).status).toBe(200);
    const ray = request.agent(app);
    await ray.get('/auth/dev-login').query({ email: 'raymond.amato@greystoneus.com' });
    expect((await ray.get('/auth/me')).body.mustEnrollTotp).toBe(true);
    const blocked = await ray.get('/api/admin/settings');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/Two-factor sign-in is required/);
    expect((await ray.get('/api/me/totp')).status).toBe(200);
    const raySetup = await ray.post('/api/me/totp/setup');
    expect(raySetup.status).toBe(200);
    await ray.post('/api/me/totp/enable').send({ code: totpCode(raySetup.body.secret) });
    expect((await ray.get('/api/admin/settings')).status).toBe(200);
    expect((await ray.get('/auth/me')).body.mustEnrollTotp).toBe(false);
    // Reps are never gated by the admin rule.
    const rep = request.agent(app);
    await rep.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    expect((await rep.get('/api/me/deals')).status).toBe(200);
    // Switching it off again lifts the gate.
    await admin.put('/api/admin/settings/security').send({ requireTotpForAdmins: false });
    expect((await admin.get('/api/admin/settings')).body.security).toEqual({ requireTotpForAdmins: false, idleMinutes: 120, totpRememberDays: 7 });
  });
});
