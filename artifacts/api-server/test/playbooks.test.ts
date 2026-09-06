import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryMailer } from '../src/services/mail.js';
import { mergeFields, normalizeRule, renderTemplate, ruleMatches, type DealFacts } from '../src/services/playbook-rules.js';
import { STARTER_PLAYBOOKS, dealFacts, dryRun, ensureStarterPlaybooks, runPlaybooks, startPlaybookScheduler } from '../src/services/playbooks.js';
import { memoryRepo } from './memory-repo.js';

async function harness() {
  const repo = memoryRepo();
  const mailer = memoryMailer();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test' }), repo, { mailer });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  const deps = { repo, mailer, origin: 'https://portal.test', appName: 'Portal' };
  return { repo, app, admin, mailer, deps };
}

describe('rules', () => {
  const facts: DealFacts = { dealId: 'F9', business: 'Acme', lender: 'MBC', product: 'MCA', funded: 50_000, fundedDate: '2026-06-01', teamId: 'team-a', ownerRepId: 'rep-zach-sanders', ownerFirst: 'Zach', paidInPct: 55, daysSinceFunding: 97, daysToMaturity: 40, bucket: 'due', bucketLabel: 'Renewable now', locUnused: 0, status: 'Refi Ready', lenderOverdue: true, clawbackDaysLeft: null, daysSinceLastNote: 20, estEligible: 27_500, estRenewalGross: 5_000, crmUrl: null, merchantContact: 'Dana', merchantEmail: 'dana@acme.test', merchantPhone: '' };
  it('validates and matches every trigger kind', () => {
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'paidInPct', atLeast: 50 }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(true);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'paidInPct', atLeast: 60 }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(false);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'daysSinceFunding', atLeast: 90 }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(true);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'daysToMaturity', atMost: 45 }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(true);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'bucket', in: ['due', 'prospecting'] }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(true);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'locUnused', atLeast: 1 }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(false);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'status', in: ['Refi Ready'] }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(true);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'lenderOverdue' }, actions: [{ kind: 'emailAdmins', subject: 's', body: 'b' }] }), facts)).toBe(true);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'clawbackWindowClosing', withinDays: 7 }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(false);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'noNoteDays', atLeast: 14 }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(true);
    // Filters narrow it.
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'paidInPct', atLeast: 50 }, filters: { lenders: ['Lendini'] }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(false);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'paidInPct', atLeast: 50 }, filters: { teams: ['team-a'], minFunded: 60_000 }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(false);
    expect(ruleMatches(normalizeRule({ trigger: { kind: 'paidInPct', atLeast: 50 }, filters: { reps: ['rep-zach-sanders'], products: ['MCA'] }, actions: [{ kind: 'task', title: 'x' }] }), facts)).toBe(true);
    expect(() => normalizeRule({ trigger: { kind: 'paidInPct' }, actions: [] })).toThrow(/Paid-in percent/);
    expect(() => normalizeRule({ trigger: { kind: 'paidInPct', atLeast: 10 }, actions: [] })).toThrow(/at least one action/);
    expect(() => normalizeRule({ trigger: { kind: 'bucket', in: [] }, actions: [{ kind: 'task', title: 'x' }] })).toThrow(/Renewal stage/);
    expect(normalizeRule({ trigger: { kind: 'lenderOverdue' }, actions: [{ kind: 'setStatus', status: 'Slow Pay' }], repeatDays: '' }).repeatDays).toBeNull();
  });
  it('renders merge fields and leaves typos visible', () => {
    const f = mergeFields(facts, { link: 'https://p/deals', repName: 'Zach Sanders', company: 'Greystone' });
    expect(renderTemplate('{{merchant}} is {{paidIn}} in; {{rep.first}} calls {{contact}}; {{eligible}} · {{nope}}', f)).toBe('Acme is 55% in; Zach calls Dana; $27,500 · {{nope}}');
  });
});

describe('deal facts', () => {
  it('computes paid-in, owner, unused line and note age from the ledger', async () => {
    const { repo } = await harness();
    const [ctx, reps, settings] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings()]);
    await repo.insertNote({ id: 'n1', dealId: 'F1', authorRepId: 'rep-leor', body: 'hi', createdAt: '2026-08-30T10:00:00Z' });
    const facts = dealFacts(ctx, reps, settings, await repo.listAllNotes(), '2026-09-06');
    const f1 = facts.find((f) => f.dealId === 'F1')!;
    expect(f1.ownerRepId).toBe('rep-zach-sanders'); // closer wins
    expect(f1.ownerFirst).toBe('Zach');
    expect(f1.teamId).toBe('team-b');
    expect(f1.daysSinceFunding).toBe(93);
    expect(f1.paidInPct).toBeGreaterThan(50);
    expect(f1.daysSinceLastNote).toBe(7);
    expect(facts.find((f) => f.dealId === 'F3')!.daysSinceLastNote).toBeNull();
    expect(facts.find((f) => f.dealId === 'F2')!.lenderOverdue).toBe(true);
  });
});

describe('running playbooks', () => {
  it('fires once per deal, opens tasks, rolls rep emails up, logs firings, and honours repeat and closed tasks', async () => {
    const { repo, deps, mailer, admin } = await harness();
    const created = await admin.post('/api/admin/playbooks').send({ name: 'Half paid', rule: { trigger: { kind: 'paidInPct', atLeast: 25 }, actions: [{ kind: 'task', title: 'Call {{merchant}}', dueInDays: 3 }, { kind: 'emailRep', subject: '{{merchant}} at {{paidIn}}', body: 'Hi {{rep.first}}, {{merchant}} is {{paidIn}} in.' }, { kind: 'emailAdmins', subject: 'FYI {{merchant}}', body: '{{rep.name}} owns it' }], repeatDays: 14 } });
    expect(created.status).toBe(201);
    const pb = created.body;
    const dry = await admin.post('/api/admin/playbooks/dry-run').send({ rule: pb.rule, playbookId: pb.id });
    expect(dry.body.matched).toBeGreaterThanOrEqual(2);
    expect(dry.body.wouldFire).toBe(dry.body.matched);
    expect(dry.body.preview.subject).toMatch(/at \d+%/);
    const run1 = await runPlaybooks(deps, '2026-09-06', 'rep-leor');
    expect(run1.fired).toBe(dry.body.matched);
    expect(run1.tasks).toBe(run1.fired);
    // Every matched deal is owned by Zach (closer): one rolled-up email to him, one to the admins.
    const toZach = mailer.sent.filter((m) => m.to === 'zach.sanders@greystoneus.com');
    expect(toZach).toHaveLength(1);
    expect(toZach[0]!.subject).toMatch(run1.fired > 1 ? /deals need a call/ : /at \d+%/);
    expect(mailer.sent.some((m) => Array.isArray(m.to) && m.to.includes('leor@greystoneus.com') && /playbook alerts|FYI/.test(m.subject))).toBe(true);
    expect((await repo.listFirings()).length).toBe(run1.fired);
    // Same day again: nothing (open tasks hold it).
    expect((await runPlaybooks(deps, '2026-09-06')).fired).toBe(0);
    const dry2 = await admin.post('/api/admin/playbooks/dry-run').send({ rule: pb.rule, playbookId: pb.id });
    expect(dry2.body.wouldFire).toBe(0);
    expect(dry2.body.rows[0].held).toBe('open task');
    // Rep logs "no answer": the task stays open with a later due date; "funded" closes it for good.
    const tasks = (await repo.listTasks({ status: 'open' }));
    const t = tasks[0]!;
    await admin.patch(`/api/admin/tasks/${t.id}`).send({ outcome: 'no_answer', note: 'left voicemail' });
    const after = (await repo.listTasks()).find((x) => x.id === t.id)!;
    expect(after.status).toBe('open');
    expect(after.dueDate).toBe('2026-09-08');
    expect((await repo.listNotes(t.dealId))[0]!.body).toMatch(/^\[No answer, try again\] left voicemail/);
    await admin.patch(`/api/admin/tasks/${t.id}`).send({ outcome: 'funded', note: 'renewed at 60k' });
    expect((await repo.listTasks()).find((x) => x.id === t.id)!.status).toBe('done');
    // Two weeks later the rule may repeat — except on the deal whose task closed with "funded".
    for (const x of await repo.listTasks({ status: 'open' })) await repo.updateTask(x.id, { status: 'done', outcome: 'called', doneAt: new Date().toISOString() });
    const run2 = await runPlaybooks(deps, '2026-09-21');
    expect(run2.fired).toBeGreaterThanOrEqual(1);
    const later = (await repo.listFirings()).filter((f) => f.firedAt.startsWith('2026-09-21'));
    expect(later.some((f) => f.dealId === t.dealId)).toBe(false);
    expect(later.some((f) => f.dealId !== t.dealId)).toBe(true);
    const log = await admin.get('/api/admin/playbooks/log');
    expect(log.body.firings[0]).toMatchObject({ playbookName: 'Half paid', repName: 'Zach Sanders' });
    const list = await admin.get('/api/admin/playbooks');
    expect(list.body.playbooks.find((p: { id: string }) => p.id === pb.id)).toMatchObject({ firings: run1.fired + run2.fired, doneTasks: expect.any(Number) });
    expect(list.body.triggers.length).toBe(9);
  });
  it('seeds the three starter rules once, and the scheduler runs once a day after the configured hour', async () => {
    const { repo, deps } = await harness();
    expect(await ensureStarterPlaybooks(repo)).toBe(3);
    expect(await ensureStarterPlaybooks(repo)).toBe(0);
    expect((await repo.listPlaybooks()).map((p) => p.name)).toEqual(STARTER_PLAYBOOKS.map((s) => s.name));
    await repo.putSetting('notifications', { playbookHourUtc: 9 });
    let clock = new Date('2026-09-06T08:00:00Z');
    const s = startPlaybookScheduler(deps, () => clock);
    expect(await s.tick()).toBe(false);
    clock = new Date('2026-09-06T09:30:00Z');
    expect(await s.tick()).toBe(true);
    expect(await s.tick()).toBe(false);
    expect(await repo.getSetting('playbooks.lastRun')).toBe('2026-09-06');
    s.stop();
  });
  it('setStatus and lenderOverdue work together, and dry-run rejects a bad rule', async () => {
    const { repo, deps, admin } = await harness();
    await admin.post('/api/admin/playbooks').send({ name: 'Slow lender', rule: { trigger: { kind: 'lenderOverdue' }, filters: { lenders: ['MBC'] }, actions: [{ kind: 'setStatus', status: 'Slow Pay' }], repeatDays: null } });
    const r = await runPlaybooks(deps, '2026-09-06');
    expect(r.statuses).toBe(2);
    expect((await repo.loadContext()).deals.find((d) => d.id === 'F2')!.dealStatus).toBe('Slow Pay');
    expect((await admin.post('/api/admin/playbooks/dry-run').send({ rule: { trigger: { kind: 'nope' } } })).status).toBe(400);
    expect((await admin.patch('/api/admin/playbooks/nope').send({ enabled: false })).status).toBe(404);
  });
});

describe('rep tasks and merchant emails', () => {
  it('lets a rep see and close their tasks, add their own, and email the merchant from a template under their name', async () => {
    const { app, admin, repo, mailer } = await harness();
    const zach = request.agent(app);
    await zach.get('/auth/dev-login').query({ email: 'zach.sanders@greystoneus.com' });
    const made = await admin.post('/api/admin/deals/F3/tasks').send({ title: 'Check in with Daniel', dueDate: '2026-09-10' });
    expect(made.status).toBe(201);
    expect(made.body.repId).toBe('rep-zach-sanders');
    const mine = (await zach.get('/api/me/tasks')).body;
    expect(mine.tasks).toHaveLength(1);
    expect(mine.tasks[0]).toMatchObject({ title: 'Check in with Daniel', business: 'F3 Business', merchantContact: 'Daniel Reyes' });
    expect(mine.outcomes.length).toBe(6);
    // Julian is not on F3: cannot see or touch it.
    const julian = request.agent(app);
    await julian.get('/auth/dev-login').query({ email: 'julian.ribak@greystoneus.com' });
    expect((await julian.get('/api/me/tasks')).body.tasks).toHaveLength(0);
    expect((await julian.patch(`/api/me/tasks/${made.body.id}`).send({ outcome: 'funded' })).status).toBe(404);
    expect((await julian.post('/api/me/deals/F3/tasks').send({ title: 'x' })).status).toBe(404);
    const own = await zach.post('/api/me/deals/F3/tasks').send({ title: 'Send renewal quote' });
    expect(own.status).toBe(201);
    expect((await zach.patch(`/api/me/tasks/${made.body.id}`).send({ outcome: 'app_submitted', note: 'sent to MBC' })).body.status).toBe('done');
    expect((await zach.get('/api/me/tasks?status=open')).body.tasks).toHaveLength(1);
    // Merchant email: preview renders the template; sending uses reply-to and leaves a note.
    const tpl = (await zach.get('/api/me/templates')).body;
    expect(tpl.merchant.map((t: { id: string }) => t.id)).toEqual(['renewal', 'draw']);
    const prev = await zach.get('/api/me/deals/F3/merchant-email/preview').query({ template: 'renewal' });
    expect(prev.body.to).toBe('f3@merchant.test');
    expect(prev.body.subject).toBe('Quick check-in on F3 Business');
    expect(prev.body.body).toMatch(/Hi Daniel Reyes,/);
    expect(prev.body.body).toMatch(/Zach Sanders\nGreystone Merchant Partners$/);
    const sent = await zach.post('/api/me/deals/F3/merchant-email').send({ templateId: 'renewal', body: prev.body.body + '\nPS see you Friday' });
    expect(sent.body).toEqual({ ok: true, to: 'f3@merchant.test' });
    const m = mailer.sent.at(-1)!;
    expect(m).toMatchObject({ to: 'f3@merchant.test', replyTo: 'zach.sanders@greystoneus.com' });
    expect(m.text).toMatch(/PS see you Friday$/);
    expect((await repo.listNotes('F3'))[0]!.body).toBe('[Emailed merchant] Quick check-in on F3 Business');
    expect((await admin.get('/api/admin/audit').query({ action: 'mail.merchant' })).body.entries).toHaveLength(1);
    // No merchant email on file → refused.
    await repo.updateDeal('F3', { merchantEmail: '' });
    expect((await zach.post('/api/me/deals/F3/merchant-email').send({ templateId: 'renewal' })).status).toBe(400);
    // Admin edits the templates.
    const saved = await admin.put('/api/admin/settings/templates').send({ merchant: [{ id: 'renewal', name: 'Renewal', subject: 'Hi {{contact}}', body: 'b' }] });
    expect(saved.body.templates.merchant).toHaveLength(1);
    expect((await admin.put('/api/admin/settings/templates').send({ merchant: [{ name: '', subject: 's', body: 'b' }] })).status).toBe(400);
  });
});
