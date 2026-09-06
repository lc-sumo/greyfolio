import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { totpCode } from '../src/auth/totp.js';
import { deviceLabel } from '../src/auth/devices.js';
import { createGeo, isPrivateIp } from '../src/services/geo.js';
import { memoryMailer } from '../src/services/mail.js';
import { memoryRepo } from './memory-repo.js';

async function harness(env: Record<string, string> = {}, deps: Parameters<typeof createApp>[2] = {}) {
  const repo = memoryRepo();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test', ...env }), repo, { mailer: memoryMailer(), ...deps });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  return { repo, app, admin };
}

describe('idle sign-out', () => {
  it('ends a session after the configured minutes without a request, and tells the user why', async () => {
    const { app, admin, repo } = await harness();
    expect((await admin.get('/auth/me')).body.idleMinutes).toBe(120);
    expect((await admin.put('/api/admin/settings/security').send({ idleMinutes: 2000 })).status).toBe(400);
    await admin.put('/api/admin/settings/security').send({ idleMinutes: 30 });
    const rep = request.agent(app);
    await rep.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    expect((await rep.get('/api/me/deals')).status).toBe(200);
    // Pretend 31 minutes passed: rewrite the session clock by signing in with a stale `seen`.
    // The cookie is signed, so instead the test moves the server clock via the setting: 0 = never, then a tiny idle window.
    await admin.put('/api/admin/settings/security').send({ idleMinutes: 0 });
    expect((await rep.get('/api/me/deals')).status).toBe(200);
    // Now set idle to 30 and age the session by re-signing the cookie through a dev login with a backdated seen.
    await admin.put('/api/admin/settings/security').send({ idleMinutes: 30 });
    const stale = request.agent(app);
    await stale.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    // The memory repo lets the test backdate the clock through the audit path: simulate by monkey-patching Date for one request.
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60_000;
    try {
      const r = await stale.get('/api/me/deals');
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/30 minutes of inactivity/);
    } finally {
      Date.now = realNow;
    }
    expect((await stale.get('/api/me/deals')).status).toBe(401); // session is gone, not just refused once
    expect((await admin.get('/api/admin/audit').query({ action: 'session.idle' })).body.entries).toHaveLength(1);
    // Active sessions keep going: the clock refreshes on every request.
    await admin.put('/api/admin/settings/security').send({ idleMinutes: 120 });
    expect((await rep.get('/api/me/deals')).status).toBe(200);
    expect((await repo.getSettings()).security.idleMinutes).toBe(120);
  });
});

describe('remembered devices', () => {
  it('skips the code for 7 days on a remembered browser, lists and forgets devices, and an admin reset forgets them all', async () => {
    const { app, admin, repo } = await harness();
    await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'Harbor-Cedar-1234' });
    const phone = request.agent(app);
    await phone.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    const setup = await phone.post('/api/me/totp/setup');
    await phone.post('/api/me/totp/enable').send({ code: totpCode(setup.body.secret) });
    await phone.post('/auth/logout');
    // Fresh browser: password → code → remembered.
    const laptop = request.agent(app);
    const first = await laptop.post('/auth/password-login').set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    expect(first.body).toEqual({ ok: false, totp: true, rememberDays: 7 });
    const second = await laptop.post('/auth/totp').set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36').send({ code: totpCode(setup.body.secret), remember: true });
    expect(second.body.ok).toBe(true);
    expect(String(second.headers['set-cookie'])).toMatch(/gs\.device=dev-[a-z0-9-]+\.[A-Za-z0-9_-]+;.*HttpOnly/);
    const devices = (await laptop.get('/api/me/devices')).body.devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ label: 'Chrome · Mac', current: true });
    expect(Date.parse(devices[0].expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    // Sign out and back in on the same browser: no code asked.
    await laptop.post('/auth/logout');
    const again = await laptop.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    expect(again.body).toMatchObject({ ok: true, trustedDevice: 'Chrome · Mac' });
    expect((await laptop.get('/api/me/deals')).status).toBe(200);
    // A different browser still gets asked; declining "remember" leaves no device.
    const other = request.agent(app);
    expect((await other.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' })).body.totp).toBe(true);
    const noRemember = await other.post('/auth/totp').send({ code: totpCode(setup.body.secret), remember: false });
    expect(noRemember.body.ok).toBe(true);
    expect(String(noRemember.headers['set-cookie'] ?? '')).not.toMatch(/gs\.device=dev-/);
    expect((await other.get('/api/me/devices')).body.devices).toHaveLength(1);
    // Forget from the laptop: next sign-in asks again.
    await laptop.post('/api/me/devices').send({}).then(() => undefined, () => undefined);
    expect((await laptop.delete(`/api/me/devices/${devices[0].id}`)).body).toEqual({ ok: true });
    await laptop.post('/auth/logout');
    expect((await laptop.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' })).body.totp).toBe(true);
    // Remember again, then the admin resets two-factor: device gone too.
    await laptop.post('/auth/totp').send({ code: totpCode(setup.body.secret) });
    expect(await repo.listTrustedDevices('rep-julian-ribak')).toHaveLength(1);
    await admin.delete('/api/admin/reps/rep-julian-ribak/totp');
    expect(await repo.listTrustedDevices('rep-julian-ribak')).toHaveLength(0);
    // Setting 0 days: no remember offered.
    await admin.put('/api/admin/settings/security').send({ totpRememberDays: 0 });
    expect((await admin.put('/api/admin/settings/security').send({ totpRememberDays: 365 })).status).toBe(400);
    expect((await repo.getSettings()).security.totpRememberDays).toBe(0);
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iPhone');
    expect(deviceLabel(undefined)).toBe('Browser');
  });
  it('expired devices are dropped and ask for a code', async () => {
    const { app, admin, repo } = await harness();
    await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'Harbor-Cedar-1234' });
    const b = request.agent(app);
    await b.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    const setup = await b.post('/api/me/totp/setup');
    await b.post('/api/me/totp/enable').send({ code: totpCode(setup.body.secret) });
    await b.post('/auth/logout');
    await b.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    await b.post('/auth/totp').send({ code: totpCode(setup.body.secret) });
    const [d] = await repo.listTrustedDevices('rep-julian-ribak');
    await repo.deleteTrustedDevice(d!.id);
    await repo.insertTrustedDevice({ ...d!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await b.post('/auth/logout');
    expect((await b.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Harbor-Cedar-1234' })).body.totp).toBe(true);
    expect(await repo.listTrustedDevices('rep-julian-ribak')).toHaveLength(0);
  });
});

describe('IP location', () => {
  it('resolves once per address, caches in settings, treats private addresses as local, and shows on the audit log', async () => {
    const calls: string[] = [];
    const lookup = async (ip: string) => {
      calls.push(ip);
      return ip === '8.8.8.8' ? { city: 'Mountain View', region: 'California', country: 'US', org: 'Google' } : null;
    };
    const repo = memoryRepo();
    const geo = createGeo(repo, { lookup });
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.20.0.1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect((await geo.locate('192.168.1.5'))!.label).toBe('local network');
    expect((await geo.locate('8.8.8.8'))!.label).toBe('Mountain View, California, US');
    expect(await geo.locate('8.8.8.8')).not.toBeNull();
    expect(await geo.locate('1.1.1.1')).toBeNull();
    expect(await geo.locate('1.1.1.1')).toBeNull(); // negative cached, no second call
    expect(calls).toEqual(['8.8.8.8', '1.1.1.1']);
    await new Promise((r) => setTimeout(r, 5));
    expect(Object.keys((await repo.getSetting<Record<string, unknown>>('geo.cache')) ?? {})).toEqual(['8.8.8.8']);
    const labels = await geo.labels(['8.8.8.8', '192.168.1.5', null, '8.8.8.8']);
    expect([...labels.entries()].sort()).toEqual([['192.168.1.5', 'local network'], ['8.8.8.8', 'Mountain View, California, US']]);
    // Through the API: the audit page carries a location per row and the CSV a column.
    const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32) }), repo, { mailer: memoryMailer(), geo });
    const admin = request.agent(app);
    await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' }).set('x-forwarded-for', '8.8.8.8');
    const page = await admin.get('/api/admin/audit').query({ action: 'login' });
    expect(page.body.geo).toBe(true);
    expect(page.body.entries[0]).toMatchObject({ ip: '8.8.8.8', location: 'Mountain View, California, US' });
    const csv = await admin.get('/api/admin/audit.csv');
    expect(csv.text.split('\r\n')[0]).toContain('"Location"');
    expect(csv.text).toContain('"8.8.8.8","Mountain View, California, US"');
    // Geo off: no lookups, `geo: false` so the page can say so.
    const off = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), GEO_PROVIDER: 'off' }), memoryRepo(), { mailer: memoryMailer() });
    const a2 = request.agent(off);
    await a2.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
    expect((await a2.get('/api/admin/audit')).body.geo).toBe(false);
  });
});
