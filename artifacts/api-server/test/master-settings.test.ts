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
    const app = createApp(configFromEnv({ SESSION_SECRET: 'x'.repeat(32), SETUP_TOKEN: 'first-boot-code' }), repo, { mailer: memoryMailer() });
    const methods = (await request(app).get('/auth/methods')).body;
    expect(methods).toMatchObject({ oidc: false, devAuth: false, password: true, setup: true });
    expect(methods.branding.company).toBe('Greystone Merchant Partners');
    // Only an active admin from the roster can claim the first password.
    expect((await request(app).post('/auth/setup').send({ token: 'first-boot-code', email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' })).status).toBe(403);
    // The setup code from the server log (or SETUP_TOKEN) is required: without it a passer-by cannot claim the owner account.
    expect((await request(app).post('/auth/setup').send({ email: 'leor@greystoneus.com', password: 'Harbor-Cedar-1234' })).status).toBe(403);
    expect((await request(app).post('/auth/setup').send({ token: 'wrong-code', email: 'leor@greystoneus.com', password: 'Harbor-Cedar-1234' })).status).toBe(403);
    expect((await request(app).post('/auth/setup').send({ token: 'first-boot-code', email: 'leor@greystoneus.com', password: 'short' })).status).toBe(400);
    const me = request.agent(app);
    const done = await me.post('/auth/setup').send({ token: 'first-boot-code', email: 'leor@greystoneus.com', password: 'Harbor-Cedar-1234' });
    expect(done.status).toBe(201);
    expect(done.body.user.role).toBe('admin');
    expect((await me.get('/api/admin/settings')).status).toBe(200);
    // Closed for good: a second call is refused and the login screen stops offering it.
    expect((await request(app).post('/auth/setup').send({ token: 'first-boot-code', email: 'leor@greystoneus.com', password: 'Maple-River-5678' })).status).toBe(403);
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
    const r = await admin.put('/api/admin/settings/notifications').send({ statements: true, payoutRecorded: false, clawbacks: false, renewalDigest: false, repQuestions: true, playbookRepEmail: false, playbookAdminEmail: true, digestHourUtc: 9 });
    expect(r.body.notifications).toEqual({ statements: true, payoutRecorded: false, clawbacks: false, renewalDigest: false, repQuestions: true, playbookRepEmail: false, playbookAdminEmail: true, digestHourUtc: 9, playbookHourUtc: 12 });
    expect((await admin.put('/api/admin/settings/notifications').send({ unknown: true })).status).toBe(400);
    expect((await admin.put('/api/admin/settings/notifications').send({ payoutRecorded: 'false' })).status).toBe(400);
    const cb = await admin.post('/api/admin/deals/F2/clawbacks').send({ amount: 500, date: '2026-08-01', reason: 'Merchant defaulted' });
    expect(cb.status).toBe(201);
    expect(cb.body.notified).toBe(0);
    expect(mailer.sent).toHaveLength(0);
    expect(await renewalDigest({ repo, mailer, origin: 'https://portal.test', appName: 'Test' }, '2026-09-03')).toEqual({ sent: 0, deals: 0 });
    // PATCH-like PUTs retain switches and hours omitted by this controller.
    const partial = await admin.put('/api/admin/settings/notifications').send({ renewalDigest: true });
    expect(partial.body.notifications).toMatchObject({ payoutRecorded: false, clawbacks: false, renewalDigest: true, playbookRepEmail: false, playbookAdminEmail: true, digestHourUtc: 9, playbookHourUtc: 12 });
    // Names from Settings › Portal sign the emails that are still on.
    await admin.put('/api/admin/settings/portal').send({ company: 'Greystone', portal: 'Rep portal' });
    await admin.put('/api/admin/settings/notifications').send({ renewalDigest: true, digestHourUtc: 9 });
    const digest = await renewalDigest({ repo, mailer, origin: 'https://portal.test', appName: 'Test' }, '2026-09-03');
    expect(digest.sent).toBe(1);
    expect(mailer.sent.at(-1)!.text).toMatch(/— Greystone Rep portal$/);
  });
});

describe('required two-factor for everyone', () => {
  it('cannot be switched on by an admin who is not enrolled, then gates every account except enrolment, and only admins can reset it', async () => {
    const { app, admin } = await harness();
    expect((await admin.put('/api/admin/settings/security').send({ requireTotp: true })).status).toBe(400);
    // Enrol the switching admin first.
    const setup = await admin.post('/api/me/totp/setup');
    await admin.post('/api/me/totp/enable').send({ code: totpCode(setup.body.secret) });
    const on = await admin.put('/api/admin/settings/security').send({ requireTotp: true });
    expect(on.body.security).toEqual({ requireTotp: true, idleMinutes: 120, totpRememberDays: 7 });
    expect((await admin.get('/auth/me')).body).toMatchObject({ mustEnrollTotp: false, totpRequired: true });
    // A rep without two-factor is held at the enrolment screen until they enrol.
    const rep = request.agent(app);
    await rep.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    expect((await rep.get('/auth/me')).body.mustEnrollTotp).toBe(true);
    const blocked = await rep.get('/api/me/deals');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/Two-factor sign-in is required/);
    expect((await rep.get('/api/me/totp')).status).toBe(200);
    const repSetup = await rep.post('/api/me/totp/setup');
    expect(repSetup.status).toBe(200);
    await rep.post('/api/me/totp/enable').send({ code: totpCode(repSetup.body.secret) });
    expect((await rep.get('/api/me/deals')).status).toBe(200);
    expect((await rep.get('/auth/me')).body.mustEnrollTotp).toBe(false);
    // Nobody turns their own off while it is required; the admin resets it from Settings › Users and the rep must enrol again.
    expect((await rep.post('/api/me/totp/disable').send({ code: totpCode(repSetup.body.secret) })).status).toBe(403);
    expect((await admin.post('/api/me/totp/disable').send({ code: totpCode(setup.body.secret) })).status).toBe(403);
    expect((await admin.delete('/api/admin/reps/rep-julian-ribak/totp')).status).toBe(200);
    expect((await rep.get('/auth/me')).body.mustEnrollTotp).toBe(true);
    // Switching it off again lifts the gate.
    await admin.put('/api/admin/settings/security').send({ requireTotp: false });
    expect((await admin.get('/api/admin/settings')).body.security).toEqual({ requireTotp: false, idleMinutes: 120, totpRememberDays: 7 });
    expect((await rep.get('/api/me/deals')).status).toBe(200);
  });
});
