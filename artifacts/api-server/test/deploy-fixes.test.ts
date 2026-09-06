import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { mailConfigFromEnv, mailerFor, memoryMailer, parseFrom } from '../src/services/mail.js';
import { memoryRepo } from './memory-repo.js';

const connectorProxy = vi.hoisted(() => vi.fn());
vi.mock('@replit/connectors-sdk', () => ({
  ReplitConnectors: class {
    proxy = connectorProxy;
  },
}));

async function harness(env: Record<string, string> = {}) {
  const repo = memoryRepo();
  const mailer = memoryMailer();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test', ...env }), repo, { mailer });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  return { repo, app, admin, mailer };
}

describe('SendGrid mailer', () => {
  it('uses an optional API key or the Replit connector and posts the v3 payload', async () => {
    expect(mailConfigFromEnv({ MAIL_PROVIDER: 'sendgrid', SENDGRID_API_KEY: 'SG.x', MAIL_FROM: 'Greystone <portal@greystoneus.com>' } as never, true)).toEqual({ provider: 'sendgrid', apiKey: 'SG.x', from: 'Greystone <portal@greystoneus.com>' });
    expect(mailConfigFromEnv({ MAIL_PROVIDER: 'sendgrid' } as never, true)).toEqual({
      provider: 'sendgrid',
      apiKey: null,
      from: 'Greystone Funded Portal <portal@greystoneus.com>',
    });
    expect(parseFrom('Greystone Portal <portal@greystoneus.com>')).toEqual({ email: 'portal@greystoneus.com', name: 'Greystone Portal' });
    expect(parseFrom('portal@greystoneus.com')).toEqual({ email: 'portal@greystoneus.com' });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: 202, headers: { 'x-message-id': 'sg-1' } });
    }) as typeof fetch;
    try {
      const m = mailerFor({ provider: 'sendgrid', apiKey: 'SG.x', from: 'Greystone <portal@greystoneus.com>' });
      expect(m.live).toBe(true);
      const r = await m.send({ to: ['a@b.c', 'd@e.f'], subject: 'Hi', text: 'Body https://x.y' });
      expect(r).toEqual({ ok: true, id: 'sg-1' });
      expect(calls[0]!.url).toBe('https://api.sendgrid.com/v3/mail/send');
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.personalizations[0].to).toEqual([{ email: 'a@b.c' }, { email: 'd@e.f' }]);
      expect(body.from).toEqual({ email: 'portal@greystoneus.com', name: 'Greystone' });
      expect(body.content[0]).toEqual({ type: 'text/plain', value: 'Body https://x.y' });
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer SG.x');
      globalThis.fetch = (async () => new Response(JSON.stringify({ errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }), { status: 403 })) as typeof fetch;
      expect(await m.send({ to: 'a@b.c', subject: 's', text: 't' })).toEqual({ ok: false, error: 'The from address does not match a verified Sender Identity.' });

      connectorProxy.mockResolvedValueOnce(new Response('', { status: 202, headers: { 'x-message-id': 'sg-connector-1' } }));
      const connected = mailerFor({ provider: 'sendgrid', apiKey: null, from: 'Greystone Funded Portal <portal@greystoneus.com>' });
      expect(await connected.send({ to: 'a@b.c', subject: 'Connected', text: 'Body' })).toEqual({ ok: true, id: 'sg-connector-1' });
      expect(connectorProxy).toHaveBeenLastCalledWith('sendgrid', '/v3/mail/send', {
        method: 'POST',
        body: expect.objectContaining({
          from: { email: 'portal@greystoneus.com', name: 'Greystone Funded Portal' },
          subject: 'Connected',
        }),
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('health', () => {
  it('answers 200 with the database and 503 without it', async () => {
    const { app } = await harness();
    expect((await request(app).get('/health')).body).toMatchObject({ ok: true, db: 'ok' });
    const broken = memoryRepo();
    broken.getSetting = async () => { throw new Error('connection refused'); };
    const app2 = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32) }), broken);
    const r = await request(app2).get('/health');
    expect(r.status).toBe(503);
    expect(r.body.db).toMatch(/connection refused/);
  });
});

describe('invites', () => {
  it('emails a 72-hour set-password link that works once', async () => {
    const { app, admin, mailer } = await harness();
    const r = await admin.post('/api/admin/reps/rep-julian-ribak/invite');
    expect(r.body).toEqual({ ok: true, email: 'julian.ribak@greystoneus.com' });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toMatch(/sign-in/);
    const token = mailer.sent[0]!.text.match(/reset\?token=([A-Za-z0-9_-]+)/)![1]!;
    const done = await request(app).post('/auth/reset').send({ token, password: 'Harbor-Cedar-1234' });
    expect(done.body).toEqual({ ok: true, email: 'julian.ribak@greystoneus.com' });
    expect((await request(app).post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' })).body.ok).toBe(true);
    // Inactive reps cannot be invited; mail off says so.
    expect((await admin.post('/api/admin/reps/rep-noah-levine/invite')).status).toBe(400);
    const off = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), MAIL_PROVIDER: 'off' }), memoryRepo());
    const a2 = request.agent(off);
    await a2.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
    expect((await a2.post('/api/admin/reps/rep-julian-ribak/invite')).status).toBe(503);
  });
});

describe('password change signs other devices out', () => {
  it('keeps the changing device, drops the rest, and admin resets drop every device', async () => {
    const { app, admin } = await harness();
    await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'Harbor-Cedar-1234' });
    const phone = request.agent(app);
    const laptop = request.agent(app);
    await phone.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    await new Promise((r) => setTimeout(r, 5));
    await laptop.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    expect((await phone.get('/api/me/deals')).status).toBe(200);
    expect((await laptop.post('/api/me/password').send({ current: 'Harbor-Cedar-1234', next: 'Maple-River-5678' })).body).toEqual({ ok: true });
    expect((await laptop.get('/api/me/deals')).status).toBe(200);
    const gone = await phone.get('/api/me/deals');
    expect(gone.status).toBe(401);
    expect(gone.body.error).toMatch(/password on this account changed/);
    // An admin reset drops the rep everywhere, including the laptop.
    await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'Cedar-Harbor-9999' });
    expect((await laptop.get('/api/me/deals')).status).toBe(401);
    // The admin's own session is untouched.
    expect((await admin.get('/api/admin/reps')).status).toBe(200);
  });
});

describe('backup', () => {
  it('downloads every table without secrets and logs the export', async () => {
    const { admin, repo } = await harness();
    await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'Harbor-Cedar-1234' });
    await admin.post('/api/admin/deals/F1/notes').send({ body: 'Called merchant' });
    const r = await admin.get('/api/admin/backup.json');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/greystone-backup-\d{4}-\d{2}-\d{2}\.json/);
    expect(r.body.format).toBe('greystone-portal-backup');
    expect(r.body.counts.deals).toBe(repo.data.deals.length);
    expect(r.body.notes).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toMatch(/scrypt|password_hash|passwordHash/);
    expect(r.body.audit.some((e: { action: string }) => e.action === 'backup')).toBe(false); // written after the snapshot
    expect((await admin.get('/api/admin/audit').query({ action: 'backup' })).body.entries).toHaveLength(1);
    const rep = request.agent((await harness()).app);
    await rep.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    expect((await rep.get('/api/admin/backup.json')).status).toBe(403);
  });
});
