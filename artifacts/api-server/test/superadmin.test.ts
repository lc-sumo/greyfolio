import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryMailer } from '../src/services/mail.js';
import { ensureSuperAdmin } from '../src/services/superadmin.js';
import { memoryRepo } from './memory-repo.js';

async function harness() {
  const repo = memoryRepo();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32) }), repo, { mailer: memoryMailer() });
  const as = async (email: string) => {
    const a = request.agent(app);
    await a.get('/auth/dev-login').query({ email });
    return a;
  };
  return { repo, app, as, superAdmin: await as('leor@greystoneus.com') };
}

describe('super admin', () => {
  it('is guaranteed on boot for the configured email, created if missing', async () => {
    const repo = memoryRepo();
    const first = await ensureSuperAdmin(repo, 'lc@greystoneus.com');
    expect(first.created).toBe(true);
    const rep = await repo.findRepByEmail('lc@greystoneus.com');
    expect(rep).toMatchObject({ role: 'admin', active: true, superAdmin: true, name: 'Leor' });
    expect((await ensureSuperAdmin(repo, 'LC@greystoneus.com')).created).toBe(false);
    // An existing rep with that email is promoted rather than duplicated.
    await repo.updateRep('rep-julian-ribak', { email: 'owner@x.test' });
    await ensureSuperAdmin(repo, 'owner@x.test');
    expect(await repo.findRep('rep-julian-ribak')).toMatchObject({ role: 'admin', superAdmin: true });
    expect((await repo.listReps()).filter((r) => r.email === 'owner@x.test')).toHaveLength(1);
    expect(configFromEnv({ SESSION_SECRET: 'x'.repeat(32) }).superAdminEmail).toBe('lc@greystoneus.com');
  });
  it('alone creates admins, changes admins, grants the flag and changes security; ordinary admins cannot', async () => {
    const { superAdmin, as, repo } = await harness();
    expect((await superAdmin.get('/auth/me')).body.superAdmin).toBe(true);
    // Super admin makes Raymond an admin; Raymond is an ordinary admin.
    expect((await superAdmin.patch('/api/admin/reps/rep-raymond-amato').send({ role: 'admin' })).status).toBe(200);
    const ray = await as('raymond.amato@greystoneus.com');
    expect((await ray.get('/auth/me')).body.superAdmin).toBe(false);
    // Raymond can run the portal but not touch admins or security.
    expect((await ray.post('/api/admin/reps').send({ name: 'New Rep', email: 'new.rep@greystoneus.com' })).status).toBe(201);
    expect((await ray.post('/api/admin/reps').send({ name: 'New Admin', email: 'new.admin@greystoneus.com', role: 'admin' })).status).toBe(403);
    expect((await ray.patch('/api/admin/reps/rep-julian-ribak').send({ role: 'admin' })).status).toBe(403);
    expect((await ray.patch('/api/admin/reps/rep-leor').send({ active: false })).status).toBe(403);
    expect((await ray.patch('/api/admin/reps/rep-raymond-amato').send({ superAdmin: true })).status).toBe(403);
    expect((await ray.post('/api/admin/reps/rep-leor/password').send({ password: 'Harbor-Cedar-1234' })).status).toBe(403);
    expect((await ray.delete('/api/admin/reps/rep-leor/totp')).status).toBe(403);
    expect((await ray.put('/api/admin/settings/security').send({ idleMinutes: 30 })).status).toBe(403);
    expect((await ray.put('/api/admin/settings/permissions').send({ merchantEmail: false })).status).toBe(200);
    // Raymond may still edit his own name and set his own password.
    expect((await ray.patch('/api/admin/reps/rep-raymond-amato').send({ name: 'Ray Amato' })).status).toBe(200);
    expect((await ray.post('/api/admin/reps/rep-raymond-amato/password').send({ password: 'Harbor-Cedar-1234' })).status).toBe(200);
    // Super admin grants the flag; the last super admin cannot be removed or demoted.
    expect((await superAdmin.patch('/api/admin/reps/rep-julian-ribak').send({ superAdmin: true })).status).toBe(400); // not an admin yet
    expect((await superAdmin.patch('/api/admin/reps/rep-leor').send({ superAdmin: false })).status).toBe(400);
    expect((await superAdmin.patch('/api/admin/reps/rep-leor').send({ role: 'manager' })).status).toBe(400);
    expect((await superAdmin.patch('/api/admin/reps/rep-raymond-amato').send({ superAdmin: true })).body.superAdmin).toBe(true);
    expect((await superAdmin.patch('/api/admin/reps/rep-leor').send({ superAdmin: false })).body.superAdmin).toBe(false);
    const roster = (await ray.get('/api/admin/reps')).body.reps;
    expect(roster.find((r: { id: string }) => r.id === 'rep-raymond-amato').superAdmin).toBe(true);
    expect((await repo.findRep('rep-leor'))!.superAdmin).toBe(false);
  });
});

describe('merchant email permission', () => {
  it('is on by default, can be switched off for everyone or blocked per rep', async () => {
    const { superAdmin, as, repo } = await harness();
    const zach = await as('zach.sanders@greystoneus.com');
    expect((await zach.get('/api/me/templates')).body.allowed).toBe(true);
    expect((await zach.get('/auth/me')).body.canEmailMerchants).toBe(true);
    expect((await zach.get('/api/me/deals/F3/merchant-email/preview').query({ template: 'renewal' })).status).toBe(200);
    // Block Zach only.
    expect((await superAdmin.patch('/api/admin/reps/rep-zach-sanders').send({ perms: { merchantEmail: false } })).body.perms).toEqual({ merchantEmail: false });
    expect((await zach.get('/api/me/templates')).body.allowed).toBe(false);
    expect((await zach.get('/api/me/deals/F3/merchant-email/preview').query({ template: 'renewal' })).status).toBe(403);
    expect((await zach.post('/api/me/deals/F3/merchant-email').send({ templateId: 'renewal' })).status).toBe(403);
    expect((await superAdmin.patch('/api/admin/reps/rep-zach-sanders').send({ perms: { merchantEmail: true } })).body.perms).toBeNull();
    expect((await zach.get('/api/me/templates')).body.allowed).toBe(true);
    // Off for everyone.
    await superAdmin.put('/api/admin/settings/permissions').send({ merchantEmail: false });
    expect((await repo.getSettings()).permissions.merchantEmail).toBe(false);
    expect((await zach.get('/api/me/templates')).body.allowed).toBe(false);
    expect((await zach.post('/api/me/deals/F3/merchant-email').send({ templateId: 'renewal' })).status).toBe(403);
    expect((await zach.get('/auth/me')).body.canEmailMerchants).toBe(false);
  });
});
