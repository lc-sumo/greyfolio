import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { base32Decode, base32Encode, hotp, otpauthUrl, totpCode, verifyTotp } from '../src/auth/totp.js';
import { memoryMailer, textToHtml } from '../src/services/mail.js';
import { renewalDigest, startDigestScheduler, statementMail } from '../src/services/notify.js';
import { memoryRepo } from './memory-repo.js';

async function harness(env: Record<string, string> = {}) {
  const repo = memoryRepo();
  const mailer = memoryMailer();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test', ...env }), repo, { mailer });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  return { repo, app, admin, mailer };
}

describe('TOTP primitives', () => {
  it('round-trips base32 and matches the RFC 6238 SHA-1 vectors', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(Buffer.from(base32Decode(secret)).toString()).toBe('12345678901234567890');
    // RFC 6238 Appendix B, SHA-1, 8 digits truncated to 6 here via hotp(…, 6)
    expect(hotp(secret, 1)).toBe('287082');
    expect(totpCode(secret, 59 * 1000)).toBe('287082');
    expect(totpCode(secret, 1_111_111_109 * 1000)).toBe('081804');
  });
  it('verifies within one step of drift and rejects junk', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1_111_111_109 * 1000;
    expect(verifyTotp(secret, '081804', now)).toBe(true);
    expect(verifyTotp(secret, '081 804', now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
    expect(otpauthUrl({ issuer: 'Greystone', account: 'a@b.c', secret })).toMatch(/^otpauth:\/\/totp\/Greystone%3Aa%40b\.c\?secret=GEZD/);
  });
});

describe('forgot password', () => {
  it('emails a one-hour link, resets with it once, and never reveals whether an email exists', async () => {
    const { app, admin, mailer } = await harness();
    await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'Harbor-Cedar-1234' });
    const unknown = await request(app).post('/auth/forgot').send({ email: 'nobody@greystoneus.com' });
    expect(unknown.status).toBe(200);
    expect(mailer.sent).toHaveLength(0);
    const asked = await request(app).post('/auth/forgot').send({ email: 'julian.ribak@greystoneus.com' });
    expect(asked.body.message).toMatch(/on its way/);
    expect(mailer.sent).toHaveLength(1);
    const link = mailer.sent[0]!.text.match(/https:\/\/portal\.test\/reset\?token=([A-Za-z0-9_-]+)/);
    expect(link).not.toBeNull();
    const token = link![1]!;
    expect((await request(app).post('/auth/reset').send({ token: 'nope', password: 'Maple-River-5678' })).status).toBe(400);
    expect((await request(app).post('/auth/reset').send({ token, password: 'weak' })).status).toBe(400);
    const done = await request(app).post('/auth/reset').send({ token, password: 'Maple-River-5678' });
    expect(done.body).toEqual({ ok: true, email: 'julian.ribak@greystoneus.com' });
    // The token is spent.
    expect((await request(app).post('/auth/reset').send({ token, password: 'Maple-River-9999' })).status).toBe(400);
    const rep = request.agent(app);
    expect((await rep.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' })).status).toBe(401);
    expect((await rep.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Maple-River-5678' })).body.ok).toBe(true);
  });
  it('caps reset emails at three an hour per address and says so when mail is off', async () => {
    const { app, mailer } = await harness();
    for (let i = 0; i < 5; i++) await request(app).post('/auth/forgot').send({ email: 'zach.sanders@greystoneus.com' });
    expect(mailer.sent).toHaveLength(3);
    const repo = memoryRepo();
    const off = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), MAIL_PROVIDER: 'off' }), repo);
    const res = await request(off).post('/auth/forgot').send({ email: 'zach.sanders@greystoneus.com' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not set up/);
  });
});

describe('two-factor sign-in', () => {
  it('enrols with a verified code, then sign-in asks for a code before the session exists', async () => {
    const { app, admin, repo } = await harness();
    await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'Harbor-Cedar-1234' });
    const rep = request.agent(app);
    await rep.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    expect((await rep.get('/api/me/totp')).body).toEqual({ enabled: false, pending: false });
    const setup = await rep.post('/api/me/totp/setup');
    expect(setup.body.otpauth).toMatch(/^otpauth:\/\/totp\//);
    expect((await rep.get('/api/me/totp')).body).toEqual({ enabled: false, pending: true });
    expect((await rep.post('/api/me/totp/enable').send({ code: '000000' })).status).toBe(400);
    expect((await rep.post('/api/me/totp/enable').send({ code: totpCode(setup.body.secret) })).body).toEqual({ ok: true, enabled: true });
    expect((await admin.get('/api/admin/reps')).body.reps.find((r: { id: string }) => r.id === 'rep-julian-ribak').hasTotp).toBe(true);

    const again = request.agent(app);
    const first = await again.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    expect(first.body).toEqual({ ok: false, totp: true });
    expect((await again.get('/auth/me')).status).toBe(401);
    expect((await again.post('/auth/totp').send({ code: '123456' })).status).toBe(401);
    const second = await again.post('/auth/totp').send({ code: totpCode(setup.body.secret) });
    expect(second.body.ok).toBe(true);
    expect((await again.get('/auth/me')).body.user.repId).toBe('rep-julian-ribak');

    // Turning it off needs a current code; an admin can reset it outright.
    expect((await again.post('/api/me/totp/disable').send({ code: '111111' })).status).toBe(400);
    expect((await admin.delete('/api/admin/reps/rep-julian-ribak/totp')).body).toEqual({ ok: true, hasTotp: false });
    expect(await repo.getTotp('rep-julian-ribak')).toEqual({ secret: null, enabled: false });
    expect((await request.agent(app).post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' })).body.ok).toBe(true);
  });
});

describe('clawbacks, notes and files on a deal', () => {
  it('records a clawback, slices it per rep, and emails each rep with a share', async () => {
    const { admin, mailer } = await harness();
    expect((await admin.post('/api/admin/deals/F2/clawbacks').send({ amount: 0 })).status).toBe(400);
    expect((await admin.post('/api/admin/deals/F2/clawbacks').send({ amount: 999_999 })).status).toBe(400);
    const res = await admin.post('/api/admin/deals/F2/clawbacks').send({ amount: 500, date: '2026-08-01', reason: 'Merchant defaulted' });
    expect(res.status).toBe(201);
    expect(res.body.clawbacks).toHaveLength(1);
    expect(res.body.clawbacks[0]).toMatchObject({ id: 'cb-F2-1', amount: 500, status: 'open' });
    // F2 gross 2,000: Julian 35% = 700, Zach 40% = 800, Raymond 5% = 100; the clawback is a quarter of gross.
    const slices = Object.fromEntries(res.body.clawbacks[0].slices.map((s: { repId: string; share: number }) => [s.repId, s.share]));
    expect(slices).toEqual({ 'rep-julian-ribak': 175, 'rep-zach-sanders': 200, 'rep-raymond-amato': 25 });
    expect(res.body.notified).toBe(3);
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(['julian.ribak@greystoneus.com', 'raymond.amato@greystoneus.com', 'zach.sanders@greystoneus.com']);
    expect(mailer.sent[0]!.text).toMatch(/Your share: \$/);
  });
  it('keeps a note history and stores files with a size and type gate', async () => {
    const { admin } = await harness();
    expect((await admin.post('/api/admin/deals/F1/notes').send({ body: '   ' })).status).toBe(400);
    await admin.post('/api/admin/deals/F1/notes').send({ body: 'Called merchant, promised wire Friday' });
    const notes = (await admin.post('/api/admin/deals/F1/notes').send({ body: 'Wire landed' })).body.notes;
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ body: 'Wire landed', author: 'Leor' });
    const gone = await admin.delete(`/api/admin/deals/F1/notes/${notes[1].id}`);
    expect(gone.body.notes).toHaveLength(1);

    const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
    expect((await admin.post('/api/admin/deals/F1/files').send({ name: 'x.exe', mime: 'application/x-msdownload', data: pdf })).status).toBe(400);
    expect((await admin.post('/api/admin/deals/F1/files').send({ name: 'big.pdf', mime: 'application/pdf', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') })).status).toBe(400);
    const up = await admin.post('/api/admin/deals/F1/files').send({ name: 'contract.pdf', mime: 'application/pdf', data: `data:application/pdf;base64,${pdf}` });
    expect(up.status).toBe(201);
    expect(up.body.files[0]).toMatchObject({ name: 'contract.pdf', mime: 'application/pdf', size: 13, uploadedByName: 'Leor' });
    expect(up.body.files[0].data).toBeUndefined();
    const dl = await admin.get(`/api/admin/deals/F1/files/${up.body.files[0].id}`);
    expect(dl.headers['content-type']).toMatch(/application\/pdf/);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="contract\.pdf"/);
    expect(dl.body.toString()).toBe('%PDF-1.4 test');
    expect((await admin.get('/api/admin/deals/F2/files/' + up.body.files[0].id)).status).toBe(404);
    expect((await admin.delete(`/api/admin/deals/F1/files/${up.body.files[0].id}`)).body.files).toHaveLength(0);
  });
});

describe('statements and digests', () => {
  it('emails each paid rep their statement when a run is approved', async () => {
    const { admin, mailer } = await harness();
    await admin.post('/api/admin/payroll/runs/run-4/pay').send({ repId: 'rep-julian-ribak', selectedKeys: ['F2|Opener|base'] });
    const approved = await admin.post('/api/admin/payroll/runs/run-4/advance');
    expect(approved.body).toMatchObject({ status: 'approved', statements: 1, notified: 1 });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: 'julian.ribak@greystoneus.com' });
    expect(mailer.sent[0]!.subject).toMatch(/^Statement ready — Sep 1 – Sep 15, 2026/);
    // Gross 700 less the 250 still owed on cb-1 (Julian's 350 share, 100 already recovered).
    expect(mailer.sent[0]!.text).toMatch(/Gross commission: +\$700\.00/);
    expect(mailer.sent[0]!.text).toMatch(/Clawbacks netted: +-\$250\.00/);
    expect(mailer.sent[0]!.text).toMatch(/Net to you: +\$450\.00/);
    expect(mailer.sent[0]!.text).toMatch(/https:\/\/portal\.test\/payments/);
    const paid = await admin.post('/api/admin/payroll/runs/run-4/advance');
    expect(paid.body).toMatchObject({ status: 'paid', notified: 0 });
    expect(mailer.sent).toHaveLength(1);
  });
  it('formats statement mail and html safely', () => {
    const m = statementMail({ origin: 'https://p', appName: 'Portal' }, { id: 'r', name: 'Ann Lee', email: 'a@b.c', role: 'rep', teamId: null, openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: true }, { period: 'Sep 1 – Sep 15, 2026', dealCount: 2, grossPaid: 1234.5, clawbacks: 34.5, netPaid: 1200 });
    expect(m.text).toMatch(/Hi Ann,/);
    expect(m.text).toMatch(/Clawbacks netted: +-\$34\.50/);
    expect(textToHtml('<b> https://p/x')).toBe('<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2a24;white-space:pre-wrap">&lt;b&gt; <a href="https://p/x">https://p/x</a></div>');
  });
  it('sends the renewal digest to admins once a day, after the chosen hour', async () => {
    const { repo, mailer } = await harness();
    const deps = { repo, mailer, origin: 'https://portal.test', appName: 'Portal' };
    // The fixture's three deals are all past their renewal mark: one digest to the one admin.
    expect(await renewalDigest(deps, '2026-09-03')).toEqual({ sent: 1, deals: 3 });
    expect(mailer.sent[0]).toMatchObject({ to: ['leor@greystoneus.com'] });
    expect(mailer.sent[0]!.subject).toMatch(/^Renewals today: \d+ ready, \d+ prospecting$/);
    expect(mailer.sent[0]!.text).toMatch(/F1 Business — MBC/);
    // A day with nothing due sends nothing.
    expect(await renewalDigest(deps, '2026-06-01')).toEqual({ sent: 0, deals: 0 });
    let clock = new Date('2026-09-03T08:00:00Z');
    const s = startDigestScheduler(deps, 13, () => clock);
    expect(await s.tick()).toBe(false);
    clock = new Date('2026-09-03T14:00:00Z');
    expect(await s.tick()).toBe(true);
    expect(await s.tick()).toBe(false);
    clock = new Date('2026-09-04T14:00:00Z');
    expect(await s.tick()).toBe(true);
    s.stop();
  });
});
