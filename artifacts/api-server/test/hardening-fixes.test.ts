import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryMailer } from '../src/services/mail.js';
import { memoryRepo } from './memory-repo.js';

async function harness() {
  const repo = memoryRepo();
  const mailer = memoryMailer();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test' }), repo, { mailer });
  const as = async (email: string) => { const a = request.agent(app); await a.get('/auth/dev-login').query({ email }); return a; };
  return { repo, app, mailer, admin: await as('leor@greystoneus.com'), raymond: await as('raymond.amato@greystoneus.com'), julian: await as('julian.ribak@greystoneus.com'), zach: await as('zach.sanders@greystoneus.com') };
}

describe('session secret', () => {
  const saved = process.env.VITEST;
  afterEach(() => { process.env.VITEST = saved; });
  it('refuses to start without a real secret unless in dev mode or tests', () => {
    delete process.env.VITEST;
    expect(() => configFromEnv({})).toThrow(/SESSION_SECRET/);
    expect(() => configFromEnv({ SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => configFromEnv({ NODE_ENV: 'production', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(configFromEnv({ SESSION_SECRET: 'y'.repeat(32) }).sessionSecret).toBe('y'.repeat(32));
    expect(configFromEnv({ AUTH_MODE: 'dev' }).sessionSecret).toMatch(/dev-only/);
    expect(configFromEnv({ NODE_ENV: 'test' }).sessionSecret).toMatch(/dev-only/);
  });
  it('generates a setup code when none is configured', () => {
    expect(configFromEnv({ AUTH_MODE: 'dev' }).setupToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(configFromEnv({ AUTH_MODE: 'dev', SETUP_TOKEN: 'abc' }).setupToken).toBe('abc');
  });
});

describe('View as keeps private material with the account holder', () => {
  it('a team lead viewing as a rep cannot list devices or download the W-9; an admin can download it', async () => {
    const { julian, raymond, admin } = await harness();
    const pdf = Buffer.from('%PDF-1.4 w9').toString('base64');
    const up = await julian.post('/api/me/files').send({ name: 'W-9.pdf', mime: 'application/pdf', data: pdf });
    const fileId = up.body.files[0].id;
    expect((await julian.get(`/api/me/files/${fileId}`)).status).toBe(200);
    // Raymond leads team A, so View as Julian is allowed — but not the SSN-bearing file or the device IPs.
    expect((await raymond.get('/api/me/files').set('X-View-As', 'rep-julian-ribak')).status).toBe(200);
    expect((await raymond.get(`/api/me/files/${fileId}`).set('X-View-As', 'rep-julian-ribak')).status).toBe(403);
    expect((await raymond.get('/api/me/devices').set('X-View-As', 'rep-julian-ribak')).status).toBe(403);
    expect((await admin.get(`/api/me/files/${fileId}`).set('X-View-As', 'rep-julian-ribak')).status).toBe(200);
    expect((await admin.get('/api/me/devices').set('X-View-As', 'rep-julian-ribak')).status).toBe(403);
  });
});

describe('rep contact edits stay on the rep\'s own deals', () => {
  it('"apply to merchant" skips a deal the rep is not on', async () => {
    const { repo, zach } = await harness();
    // F1 becomes Julian's alone but shares F3's merchant email.
    await repo.updateDeal('F1', { openerId: 'rep-julian-ribak', closerId: 'rep-julian-ribak', overrideId: null, merchantEmail: 'f3@merchant.test' });
    const r = await zach.patch('/api/me/deals/F3/contact').send({ merchantPhone: '(917) 555-0199', applyToMerchant: true });
    expect(r.status).toBe(200);
    expect(r.body.updatedDeals).toBe(1);
    const deals = (await repo.loadContext()).deals;
    expect(deals.find((d) => d.id === 'F3')!.merchantPhone).toBe('(917) 555-0199');
    expect(deals.find((d) => d.id === 'F1')!.merchantPhone).toBe('(201) 555-0100');
  });
  it('merchant email needs a template', async () => {
    const { zach } = await harness();
    const r = await zach.post('/api/me/deals/F3/merchant-email').send({ subject: 'Hello', body: 'free text' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/template/);
  });
});

describe('calendar feed tokens', () => {
  it('stores only a hash, shows the link once, and upgrades a legacy plaintext token on first use', async () => {
    const { repo, app, zach } = await harness();
    const made = await zach.post('/api/me/calendar');
    const token = new URL(made.body.url).pathname.replace('/calendar/', '').replace('.ics', '');
    const stored = await repo.getCalendarToken('rep-zach-sanders');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(token);
    expect((await zach.get('/api/me/calendar')).body).toEqual({ url: null, enabled: true });
    expect((await request(app).get(`/calendar/${token}.ics`)).status).toBe(200);
    expect((await request(app).get(`/calendar/${stored}.ics`)).status).toBe(404);
    // A feed subscribed before hashing: the plaintext token still works and is rehashed.
    await repo.setCalendarToken('rep-zach-sanders', 'legacy-plaintext-token-abcdefghij');
    expect((await request(app).get('/calendar/legacy-plaintext-token-abcdefghij.ics')).status).toBe(200);
    expect(await repo.getCalendarToken('rep-zach-sanders')).toMatch(/^[0-9a-f]{64}$/);
    expect((await request(app).get('/calendar/legacy-plaintext-token-abcdefghij.ics')).status).toBe(200);
  });
});
