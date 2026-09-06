import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryMailer } from '../src/services/mail.js';
import { memoryRepo } from './memory-repo.js';

describe('reps complete merchant profiles', () => {
  it('flags missing fields, lets the rep fill them on their own deals, syncs across the merchant, and can be switched off', async () => {
    const repo = memoryRepo();
    await repo.updateDeal('F3', { merchantContact: '', merchantEmail: '', merchantPhone: '' });
    await repo.updateDeal('F1', { merchantEmail: 'shared@merchant.test', merchantPhone: '' });
    await repo.updateDeal('F2', { merchantEmail: 'shared@merchant.test', merchantPhone: '' });
    const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32) }), repo, { mailer: memoryMailer() });
    const zach = request.agent(app);
    await zach.get('/auth/dev-login').query({ email: 'zach.sanders@greystoneus.com' });
    const before = (await zach.get('/api/me/deals/F3')).body;
    expect(before.missingContact).toEqual(['contact', 'email', 'phone']);
    expect((await zach.get('/auth/me')).body.canEditContacts).toBe(true);
    // Fill it in; business name cannot be changed by a rep.
    const r = await zach.patch('/api/me/deals/F3/contact').send({ merchantContact: 'Dana Reyes', merchantEmail: 'Dana@Acme.Test', merchantPhone: '(212) 555-0100', business: 'Hijacked' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ business: 'F3 Business', merchantContact: 'Dana Reyes', merchantEmail: 'dana@acme.test', merchantPhone: '(212) 555-0100', missingContact: [], updatedDeals: 1 });
    expect((await repo.loadContext()).deals.find((d) => d.id === 'F3')!.merchantEmail).toBe('dana@acme.test');
    expect((await zach.patch('/api/me/deals/F3/contact').send({ merchantEmail: 'nope' })).status).toBe(400);
    // Apply to the merchant: both deals sharing the email get the phone.
    const r2 = await zach.patch('/api/me/deals/F1/contact').send({ merchantPhone: '(917) 555-0199', applyToMerchant: true });
    expect(r2.body.updatedDeals).toBe(2);
    expect((await repo.loadContext()).deals.find((d) => d.id === 'F2')!.merchantPhone).toBe('(917) 555-0199');
    // Not the rep's deal → 404; View as → 403; audit row exists.
    const julian = request.agent(app);
    await julian.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    expect((await julian.patch('/api/me/deals/F3/contact').send({ merchantPhone: 'x' })).status).toBe(404);
    const admin = request.agent(app);
    await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
    expect((await admin.patch('/api/me/deals/F3/contact').set('X-View-As', 'rep-zach-sanders').send({ merchantPhone: 'x' })).status).toBe(403);
    expect((await admin.get('/api/admin/audit').query({ action: 'deal.contact' })).body.entries.length).toBe(2);
    // Admin switches it off.
    await admin.put('/api/admin/settings/permissions').send({ contactEdit: false });
    expect((await zach.patch('/api/me/deals/F3/contact').send({ merchantPhone: '1' })).status).toBe(403);
    expect((await zach.get('/auth/me')).body.canEditContacts).toBe(false);
    // The deals list carries the flag for the "missing info" pill.
    const list = (await zach.get('/api/me/deals')).body.deals;
    expect(list.find((d: { id: string }) => d.id === 'F3').missingContact).toEqual([]);
  });
});
