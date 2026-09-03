import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { hashPassword, passwordProblem, temporaryPassword, verifyPassword } from '../src/auth/password.js';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryRepo } from './memory-repo.js';

describe('password hashing', () => {
  it('hashes with scrypt and verifies in constant time', async () => {
    const h = await hashPassword('Harbor-Cedar-1234');
    expect(h.startsWith('scrypt$16384$')).toBe(true);
    expect(await verifyPassword('Harbor-Cedar-1234', h)).toBe(true);
    expect(await verifyPassword('Harbor-Cedar-1235', h)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });
  it('rejects weak passwords and makes readable temporary ones', () => {
    expect(passwordProblem('short1')).toMatch(/at least 10/);
    expect(passwordProblem('nodigitsatall')).toMatch(/letter and one number/);
    expect(passwordProblem('Harbor-Cedar-1234')).toBeNull();
    expect(passwordProblem(temporaryPassword())).toBeNull();
  });
});

describe('email + password sign-in', () => {
  async function harness() {
    const repo = memoryRepo();
    const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32) }), repo);
    const admin = request.agent(app);
    await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
    return { repo, app, admin };
  }
  it('admin sets a password, the rep signs in with it, wrong ones are refused and throttled', async () => {
    const { app, admin } = await harness();
    expect((await request(app).get('/auth/methods')).body).toMatchObject({ password: true });
    expect((await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'weak' })).status).toBe(400);
    const set = await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: 'Harbor-Cedar-1234' });
    expect(set.body).toEqual({ hasPassword: true });
    expect((await admin.get('/api/admin/reps')).body.reps.find((r: { id: string }) => r.id === 'rep-julian-ribak').hasPassword).toBe(true);
    const rep = request.agent(app);
    expect((await rep.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'nope-nope-1' })).status).toBe(401);
    const ok = await rep.post('/auth/password-login').send({ email: 'Julian.Ribak@greystoneus.com', password: 'Harbor-Cedar-1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ repId: 'rep-julian-ribak', role: 'rep' });
    expect((await rep.get('/api/me')).status).toBe(200);
    // a rep without a password cannot sign in this way, and reps cannot set passwords for others
    expect((await request(app).post('/auth/password-login').send({ email: 'zach.sanders@greystoneus.com', password: 'Harbor-Cedar-1234' })).status).toBe(401);
    expect((await rep.post('/api/admin/reps/rep-zach-sanders/password').send({ password: 'Harbor-Cedar-1234' })).status).toBe(403);
    // the rep changes their own password
    expect((await rep.post('/api/me/password').send({ current: 'wrong-wrong-1', next: 'Summit-Willow-9876' })).status).toBe(400);
    expect((await rep.post('/api/me/password').send({ current: 'Harbor-Cedar-1234', next: 'Summit-Willow-9876' })).status).toBe(200);
    const again = request.agent(app);
    expect((await again.post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Summit-Willow-9876' })).status).toBe(200);
    // throttle after five failures
    for (let i = 0; i < 5; i++) await request(app).post('/auth/password-login').send({ email: 'throttle@greystoneus.com', password: 'x-1' });
    expect((await request(app).post('/auth/password-login').send({ email: 'throttle@greystoneus.com', password: 'x-1' })).status).toBe(429);
    // admin clears it
    expect((await admin.post('/api/admin/reps/rep-julian-ribak/password').send({ password: null })).body).toEqual({ hasPassword: false });
    expect((await request(app).post('/auth/password-login').send({ email: 'julian.ribak@greystoneus.com', password: 'Summit-Willow-9876' })).status).toBe(401);
  });
});
