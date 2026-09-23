import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryMailer } from '../src/services/mail.js';
import { memoryRepo } from './memory-repo.js';

const header = 'Deal ID,Date,Business Name,Lender,Product,Funded / Draw Amount ($),Comm %,Gross Commission ($),Opener,Opener $,Total Rep Payout ($),Commission Status,Rep Paid Date';
const row = 'F990,01/10/2025,Acme,MBC,MCA,10000,10%,1000,Leor,200,200,Waiting for payment,';
const csv = `${header}\n${row}\n,,,,,,,,,,,,0`;
const review = {
  termsConfirmed: true, lender: 'unpaid', lenderAmount: null, lenderDate: null,
  reps: 'unpaid', repAmount: null, repDate: null, notes: '',
};

async function harness() {
  const repo = memoryRepo();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test' }), repo, { mailer: memoryMailer() });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  return { repo, admin };
}

describe('resumable tracker reviews', () => {
  it('stages only actual deal rows, saves progress, preserves unchanged reviews and resets changed rows without posting money', async () => {
    const { repo, admin } = await harness();
    const before = await repo.loadContext();
    const staged = await admin.post('/api/admin/import-review/stage').send({ csv });
    expect(staged.status).toBe(200);
    expect(staged.body).toMatchObject({ total: 1, skippedTemplateRows: 1, created: 1 });
    expect((await admin.post('/api/admin/import').send({ csv })).status).toBe(409);
    let item = (await admin.get('/api/admin/import-review')).body.rows[0];
    expect(item.sourceId).toBe('F990');
    const saved = await admin.patch('/api/admin/import-review/F990').send({ revision: item.revision, review, status: 'in_progress' });
    expect(saved.status).toBe(200);
    expect(saved.body.review.termsConfirmed).toBe(true);
    expect((await admin.patch('/api/admin/import-review/F990').send({ revision: item.revision, review, status: 'reviewed' })).status).toBe(409);
    expect((await admin.post('/api/admin/import-review/stage').send({ csv })).body.unchanged).toBe(1);
    item = (await admin.get('/api/admin/import-review')).body.rows[0];
    expect(item.review.termsConfirmed).toBe(true);
    expect((await admin.patch('/api/admin/import-review/F990').send({ revision: item.revision, review, status: 'reviewed' })).status).toBe(200);
    expect((await admin.post('/api/admin/import-review/stage').send({ csv: csv.replace('Acme', 'Acme Inc') })).body.changed).toBe(1);
    item = (await admin.get('/api/admin/import-review')).body.rows[0];
    expect(item.status).toBe('needs_attention');
    expect(item.review.lender).toBe('unpaid'); // fresh suggestion, not a restored confirmation
    expect(item.review.termsConfirmed).toBe(false);
    const after = await repo.loadContext();
    expect(after.deals).toEqual(before.deals);
    expect(after.lines).toEqual(before.lines);
  });

  it('flags duplicate IDs and disallows overpayment or incomplete review', async () => {
    const { admin } = await harness();
    const staged = await admin.post('/api/admin/import-review/stage').send({ csv: `${header}\n${row}\n${row.replace('Acme', 'Other')}` });
    expect(staged.body.total).toBe(2);
    const items = (await admin.get('/api/admin/import-review')).body.rows;
    expect(items).toHaveLength(2);
    expect(items.every((r: { issues: string[] }) => r.issues.some((x) => x.includes('duplicated')))).toBe(true);
    const id = encodeURIComponent(items[0].sourceId);
    expect((await admin.patch(`/api/admin/import-review/${id}`).send({ revision: items[0].revision, review, status: 'reviewed' })).status).toBe(400);
    expect((await admin.patch(`/api/admin/import-review/${id}`).send({
      revision: items[0].revision, review: { ...review, reps: 'paid', repAmount: 300, repDate: '2025-01-11' }, status: 'in_progress',
    })).status).toBe(400);
    expect((await admin.patch(`/api/admin/import-review/${id}`).send({
      revision: items[0].revision, review: { ...review, lender: 'unknown' }, status: 'reviewed',
    })).status).toBe(400);
  });

  it('hides removed rows without deleting their review, so a later re-upload can restore progress', async () => {
    const { admin } = await harness();
    const second = row.replace('F990', 'F991').replace('Acme', 'Second');
    await admin.post('/api/admin/import-review/stage').send({ csv: `${header}\n${row}\n${second}` });
    const first = (await admin.get('/api/admin/import-review')).body.rows.find((r: { sourceId: string }) => r.sourceId === 'F991');
    expect((await admin.patch('/api/admin/import-review/F991').send({ revision: first.revision, review, status: 'in_progress' })).status).toBe(200);
    await admin.post('/api/admin/import-review/stage').send({ csv });
    expect((await admin.get('/api/admin/import-review')).body.rows.map((r: { sourceId: string }) => r.sourceId)).toEqual(['F990']);
    expect((await admin.post('/api/admin/import-review/stage').send({ csv: `${header}\n${row}\n${second}` })).body.unchanged).toBe(2);
    expect((await admin.get('/api/admin/import-review')).body.rows.find((r: { sourceId: string }) => r.sourceId === 'F991').review.termsConfirmed).toBe(true);
  });

  it('prechecks sheet-paid reps, lets an admin correct deal fields, and does not require notes', async () => {
    const { admin, repo } = await harness();
    const paidCsv = `${header}\n${row.replace('MBC', 'Missing Lender').replace('Waiting for payment,', 'YES - Paid In Full,01/11/2025')}`;
    expect((await admin.post('/api/admin/import-review/stage').send({ csv: paidCsv })).status).toBe(200);
    const initial = (await admin.get('/api/admin/import-review')).body.rows[0];
    expect(initial.review).toMatchObject({ reps: 'paid', repAmount: 200, repDate: '2025-01-11', lender: 'unknown', termsConfirmed: false });
    expect(initial.issues.some((x: string) => x.includes('Missing Lender'))).toBe(true);
    const saved = await admin.patch('/api/admin/import-review/F990').send({
      revision: initial.revision,
      review: { ...initial.review, lender: 'unpaid', termsConfirmed: true, terms: { lender: 'MBC' }, notes: '',
        repPayments: [{ repId: 'rep-leor', role: 'Opener', amount: 200, paidAt: '2025-01-11' }] },
      status: 'reviewed',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.review.terms.lender).toBe('MBC');
    const result = (await admin.get('/api/admin/import-review')).body.rows[0];
    expect(result.source.lender).toBe('Missing Lender');
    expect(result.issues).toEqual([]);
    expect((await repo.loadContext()).deals.some((d) => d.id === 'F990')).toBe(false);
  });
});