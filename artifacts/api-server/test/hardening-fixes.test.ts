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

describe('low-severity hardening', () => {
  it('a TOTP code is accepted once per account', async () => {
    const { totpCode, verifyTotpOnce } = await import('../src/auth/totp.js');
    const secret = 'JBSWY3DPEHPK3PXP';
    const at = 1_800_000_000_000;
    const code = totpCode(secret, at);
    expect(verifyTotpOnce('rep-a', secret, code, at)).toBe(true);
    expect(verifyTotpOnce('rep-a', secret, code, at + 5_000)).toBe(false);
    expect(verifyTotpOnce('rep-b', secret, code, at)).toBe(true);
    expect(verifyTotpOnce('rep-a', secret, totpCode(secret, at + 30_000), at + 30_000)).toBe(true);
    expect(verifyTotpOnce('rep-a', secret, totpCode(secret, at - 30_000), at)).toBe(true);
    expect(verifyTotpOnce('rep-a', secret, totpCode(secret, at - 30_000), at)).toBe(false);
  });
  it('login failures lock per email and per email+IP, and unknown emails cost a hash check', async () => {
    const { app } = await harness();
    for (let i = 0; i < 5; i++) expect((await request(app).post('/auth/password-login').send({ email: 'nobody@greystoneus.com', password: 'x' })).status).toBe(401);
    expect((await request(app).post('/auth/password-login').send({ email: 'nobody@greystoneus.com', password: 'x' })).status).toBe(429);
    const { loginKeys, noteLoginFailure, loginLocked } = await import('../src/auth/password.js');
    expect(loginKeys('a@b.c', '10.0.0.1')).toEqual(['a@b.c', 'a@b.c|10.0.0.1']);
    for (let i = 0; i < 5; i++) noteLoginFailure('k1', 1_000);
    expect(loginLocked('k1', 1_000)).toBe(15);
    expect(loginLocked('k1', 1_000 + 16 * 60_000)).toBe(0);
    // Stale counts reset instead of accumulating forever.
    noteLoginFailure('k1', 1_000 + 20 * 60_000);
    expect(loginLocked('k1', 1_000 + 20 * 60_000)).toBe(0);
  });
  it('CSV cells that would start a formula are prefixed, negative numbers are not', async () => {
    const { repo, admin } = await harness();
    // The lender lands at the start of a cell in the QuickBooks export; a business name would too on other exports.
    await repo.updateDeal('F1', { lender: '=HYPERLINK("http://evil","click")' });
    const csv = await admin.get('/api/admin/books/cash.csv').query({ year: 2026 });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(csv.text).not.toMatch(/"=HYPERLINK/);
    // Negative amounts stay numeric: a clawback recovery line is a plain negative number.
    expect(csv.text).toMatch(/"-\d/);
    expect(csv.text).not.toMatch(/"'-\d/);
  });
  it('outbound mail HTML cannot break out of the link attribute', async () => {
    const { textToHtml } = await import('../src/services/mail.js');
    const html = textToHtml('see https://x.test/a"onmouseover="alert(1) and "quoted" text');
    expect(html).not.toMatch(/[^&]"onmouseover/);
    // The link ends where the quote began; the rest is inert, escaped text.
    expect(html).toContain('<a href="https://x.test/a">https://x.test/a</a>&quot;onmouseover=&quot;alert(1)');
    expect(html).toContain('&quot;quoted&quot;');
  });
  it('caps files per rep and hides internal error detail behind a reference', async () => {
    const { julian } = await harness();
    const pdf = Buffer.from('%PDF-1.4 x').toString('base64');
    for (let i = 0; i < 25; i++) expect((await julian.post('/api/me/files').send({ name: `f${i}.pdf`, mime: 'application/pdf', data: pdf })).status).toBe(201);
    const over = await julian.post('/api/me/files').send({ name: 'one-more.pdf', mime: 'application/pdf', data: pdf });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/at most 25 files/);
  });
});
