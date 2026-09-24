import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryMailer } from '../src/services/mail.js';
import { memoryRepo } from './memory-repo.js';
import type { ImportReviewDecision } from '../src/repo.js';
import { payableLines, planPayout, applyPayout, planVoid, applyVoid, isDealFullyPaid, newDraw } from '@greystone/commission';
import { repDealView } from '../src/scope.js';

const header = 'Deal ID,Date,Business Name,Lender,Product,Funded / Draw Amount ($),Factor Rate,Term (bus. days),Comm %,Gross Commission ($),Opener,Opener $,Total Rep Payout ($),Commission Status,Rep Paid Date';
const row = 'F990,01/10/2025,Acme,MBC,MCA,10000,1.3,120,10%,1000,Leor,200,200,Partially Paid,01/20/2025';
const decision: ImportReviewDecision = {
  termsConfirmed: true, lender: 'paid', lenderAmount: 500, lenderDate: '2025-01-15',
  lenderWeeks: null, reps: 'paid', repAmount: 200, repDate: '2025-01-20',
  repPayments: [{ repId: 'rep-leor', role: 'Opener', amount: 200, paidAt: '2025-01-20' }], notes: '',
};

async function setup(source = row) {
  const repo = memoryRepo();
  const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test' }), repo, { mailer: memoryMailer() });
  const admin = request.agent(app);
  await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
  expect((await admin.post('/api/admin/import-review/stage').send({ csv: `${header}\n${source}` })).status).toBe(200);
  const id = source.split(',')[0]!;
  const get = async () => (await admin.get('/api/admin/import-review')).body.rows.find((r: { sourceId: string }) => r.sourceId === id);
  const reviewed = async (input: ImportReviewDecision = decision) => {
    const item = await get();
    const result = await admin.patch(`/api/admin/import-review/${id}`).send({ revision: item.revision, status: 'reviewed', review: input });
    expect(result.status).toBe(200);
    return result.body;
  };
  const preview = async () => admin.post(`/api/admin/import-review/${id}/preview`).send({});
  const commit = async (revision: number, previewToken: string) =>
    admin.post(`/api/admin/import-review/${id}/commit`).send({ revision, previewToken });
  return { repo, admin, id, get, reviewed, preview, commit };
}

describe('reviewed historical import', () => {
  it('imports a Revenued self-parent initial LOC and a distinct-ID child draw into one Master Deal', async () => {
    const repo = memoryRepo();
    const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test' }), repo, { mailer: memoryMailer() });
    const admin = request.agent(app);
    await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
    const drawHeader = header.replace('Deal ID,Date', 'Deal ID,Parent Deal,Date');
    const initial = 'F998,F998,01/10/2025,Revenued Facility,Revenued,LOC - INITIAL,10000,,90,8%,800,Leor,160,160,Waiting for payment,';
    const child = 'F999,F998,02/10/2025,Revenued Facility,Revenued,LOC DRAW,2000,,,4%,80,Leor,16,16,Waiting for payment,';
    const csv = `${drawHeader}\n${initial}\n${child}`;
    expect((await admin.post('/api/admin/import-review/stage').send({ csv })).body.total).toBe(2);
    const unpaid: ImportReviewDecision = {
      ...decision, lender: 'unpaid', lenderAmount: null, lenderDate: null,
      reps: 'unpaid', repAmount: null, repDate: null, repPayments: [],
    };
    const paidChild: ImportReviewDecision = {
      ...decision, lenderAmount: 80, lenderDate: '2025-02-15',
      repAmount: 16, repDate: '2025-02-20',
      repPayments: [{ repId: 'rep-leor', role: 'Opener', amount: 16, paidAt: '2025-02-20' }],
    };
    const rows = (await admin.get('/api/admin/import-review')).body.rows;
    expect(rows.map((r: { sourceId: string; source: { parent: string } }) => [r.sourceId, r.source.parent]))
      .toEqual([['F998', 'F998'], ['F999', 'F998']]);
    const childSaved = await admin.patch('/api/admin/import-review/F999').send({
      revision: rows[1].revision, status: 'reviewed', review: paidChild,
    });
    expect(childSaved.status).toBe(200);
    const waiting = await admin.post('/api/admin/import-review/F999/preview').send({});
    expect(waiting.body.problems).toContain('Import parent F998 before its draw.');
    expect((await admin.post('/api/admin/import-review/F999/commit').send({
      revision: childSaved.body.revision, previewToken: waiting.body.previewToken,
    })).status).toBe(409);
    const parentSaved = await admin.patch('/api/admin/import-review/F998').send({
      revision: rows[0].revision, status: 'reviewed', review: unpaid,
    });
    expect(parentSaved.status).toBe(200);
    const parentPreview = await admin.post('/api/admin/import-review/F998/preview').send({});
    expect(parentPreview.body).toMatchObject({ action: 'new', problems: [] });
    expect((await admin.post('/api/admin/import-review/F998/commit').send({
      revision: parentSaved.body.revision, previewToken: parentPreview.body.previewToken,
    })).status).toBe(201);
    const childPreview = await admin.post('/api/admin/import-review/F999/preview').send({});
    expect(childPreview.body).toMatchObject({ action: 'draw', problems: [] });
    expect((await admin.post('/api/admin/import-review/F999/commit').send({
      revision: childSaved.body.revision, previewToken: childPreview.body.previewToken,
    })).status).toBe(201);
    const context = await repo.loadContext();
    expect(context.deals.filter((d) => d.id === 'F998')).toHaveLength(1);
    expect(context.deals.some((d) => d.id === 'F999')).toBe(false);
    expect(context.deals.find((d) => d.id === 'F998')?.draws).toMatchObject([{ amount: 2000, gross: 80, collected: 80 }]);
    expect(context.lines.filter((l) => l.dealId === 'F998')).toMatchObject([{ segmentKey: 'D1', repId: 'rep-leor', amount: 16, paidAt: '2025-02-20' }]);
    expect((await admin.post('/api/admin/import-review/F999/commit').send({
      revision: childSaved.body.revision, previewToken: childPreview.body.previewToken,
    })).status).toBe(409);
    expect((await admin.post('/api/admin/import-review/stage').send({ csv })).body.unchanged).toBe(2);
    expect((await admin.get('/api/admin/import-review')).body.rows.map((r: { status: string }) => r.status))
      .toEqual(['imported', 'imported']);
  });

  it('blocks an already-entered or near-matching LOC draw without posting its receipt or rep payout', async () => {
    const h = await setup('F997,01/10/2025,Facility,Revenued,LOC - INITIAL,10000,,90,8%,800,Leor,160,160,Waiting for payment,');
    const unpaid: ImportReviewDecision = {
      ...decision, lender: 'unpaid', lenderAmount: null, lenderDate: null,
      reps: 'unpaid', repAmount: null, repDate: null, repPayments: [],
    };
    const parent = await h.reviewed(unpaid);
    const parentPreview = await h.preview();
    expect(parentPreview.body.problems).toEqual([]);
    expect((await h.commit(parent.revision, parentPreview.body.previewToken)).status).toBe(201);
    const facility = (await h.repo.loadContext()).deals.find((d) => d.id === 'F997')!;
    await h.repo.insertDraw('F997', newDraw(facility, {
      amount: 2000, date: '2025-02-10', commRate: .04, partner: null, termDays: null, factor: null, frequency: 'Weekly',
    }));
    const before = await h.repo.loadContext();
    const drawHeader = header.replace('Deal ID,Date', 'Deal ID,Parent Deal,Date');
    const exact = 'F996,F997,02/10/2025,Facility,Revenued,LOC DRAW,2000,,,4%,80,Leor,16,16,Partially Paid,02/20/2025';
    const near = exact.replace('F996,F997,02/10/2025', 'F995,F997,02/15/2025');
    expect((await h.admin.post('/api/admin/import-review/stage').send({ csv: `${drawHeader}\n${exact}\n${near}` })).status).toBe(200);
    const paid: ImportReviewDecision = {
      ...decision, lenderAmount: 80, lenderDate: '2025-02-15', repAmount: 16, repDate: '2025-02-20',
      repPayments: [{ repId: 'rep-leor', role: 'Opener', amount: 16, paidAt: '2025-02-20' }],
    };
    for (const id of ['F995', 'F996']) {
      const row = (await h.admin.get('/api/admin/import-review')).body.rows.find((r: { sourceId: string }) => r.sourceId === id);
      const saved = await h.admin.patch(`/api/admin/import-review/${id}`).send({ revision: row.revision, status: 'reviewed', review: paid });
      expect(saved.status).toBe(200);
      const preview = await h.admin.post(`/api/admin/import-review/${id}/preview`).send({});
      expect(preview.body.problems).toEqual(expect.arrayContaining([expect.stringContaining('Possible existing draw D1')]));
      expect(preview.body.draw).toBeNull();
      expect(preview.body.payouts).toEqual([]);
      expect((await h.admin.post(`/api/admin/import-review/${id}/commit`).send({
        revision: saved.body.revision, previewToken: preview.body.previewToken,
      })).status).toBe(409);
    }
    expect(await h.repo.loadContext()).toEqual(before);
  });

  it('previews and commits an unpaid deal without posting cash, then locks its imported review', async () => {
    const source = row.replace('Partially Paid,01/20/2025', 'Waiting for payment,');
    const h = await setup(source);
    const unpaid: ImportReviewDecision = {
      ...decision, lender: 'unpaid', lenderAmount: null, lenderDate: null,
      reps: 'unpaid', repAmount: null, repDate: null, repPayments: [],
    };
    const saved = await h.reviewed(unpaid);
    const before = await h.repo.loadContext();
    const preview = await h.preview();
    expect(preview.body.problems).toEqual([]);
    expect(preview.body.receipt).toBeNull();
    expect(preview.body.payouts).toEqual([]);
    expect((await h.repo.loadContext()).deals).toEqual(before.deals);
    expect((await h.commit(saved.revision, preview.body.previewToken)).status).toBe(201);
    const after = await h.repo.loadContext();
    expect(after.deals.find((d) => d.id === h.id)?.commCollected).toBe(0);
    expect(after.lines.filter((l) => l.dealId === h.id)).toEqual([]);
    expect((await h.get()).status).toBe('imported');
    expect((await h.admin.patch(`/api/admin/import-review/${h.id}`).send({
      revision: saved.revision + 1, review: unpaid, status: 'reviewed',
    })).status).toBe(409);
    expect((await h.admin.post('/api/admin/import-review/stage').send({ csv: `${header}\n${source}` })).body.unchanged).toBe(1);
    expect((await h.get()).status).toBe('imported');
  });

  it('keeps review and preview read-only, commits exact collection and per-rep ledger once', async () => {
    const h = await setup();
    expect((await h.preview()).body.problems.length).toBeGreaterThan(0);
    const saved = await h.reviewed();
    const before = await h.repo.loadContext();
    const pv = await h.preview();
    expect(pv.status).toBe(200);
    expect(pv.body.problems).toEqual([]);
    expect(pv.body.receipt).toBeTruthy();
    expect(pv.body.payouts).toMatchObject([{ repId: 'rep-leor', role: 'Opener', amount: 200, paidAt: '2025-01-20' }]);
    expect((await h.repo.loadContext()).deals).toEqual(before.deals);
    expect((await h.repo.loadContext()).lines).toEqual(before.lines);
    const committed = await h.commit(saved.revision, pv.body.previewToken);
    expect(committed.status).toBe(201);
    const ctx = await h.repo.loadContext();
    expect(ctx.deals.find((d) => d.id === 'F990')?.commCollected).toBe(500);
    expect(ctx.lines.filter((l) => l.dealId === 'F990')).toMatchObject([
      { repId: 'rep-leor', role: 'Opener', amount: 200, paidAt: '2025-01-20' },
    ]);
    expect((await h.commit(saved.revision, pv.body.previewToken)).status).toBe(409);
    expect((await h.repo.loadContext()).lines.filter((l) => l.dealId === 'F990')).toHaveLength(1);
  });

  it('uses reviewed corrections rather than an incorrect source lender when importing', async () => {
    const h = await setup(row.replace('MBC', 'Missing Lender'));
    const saved = await h.reviewed({ ...decision, terms: { lender: 'MBC' } });
    const preview = await h.preview();
    expect(preview.body.problems).toEqual([]);
    expect(preview.body.deal.lender).toBe('MBC');
    expect((await h.commit(saved.revision, preview.body.previewToken)).status).toBe(201);
    expect((await h.repo.loadContext()).deals.find((d) => d.id === 'F990')?.lender).toBe('MBC');
  });

  it('prices confirmed PSF and referral dollars and retains the confirmed deal status', async () => {
    const economicsHeader = `${header},Referral Partner,Referral Fee ($),PSF (% or $),PSF $ (auto),Deal Status`;
    const source = `${row.replace('10%,1000', '9%,1000')},HUB TRACKER,50,1%,100,Default`;
    const repo = memoryRepo();
    const app = createApp(configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), APP_ORIGIN: 'https://portal.test' }), repo, { mailer: memoryMailer() });
    const admin = request.agent(app);
    await admin.get('/auth/dev-login').query({ email: 'leor@greystoneus.com' });
    expect((await admin.post('/api/admin/import-review/stage').send({ csv: `${economicsHeader}\n${source}` })).status).toBe(200);
    const initial = (await admin.get('/api/admin/import-review')).body.rows[0];
    const saved = await admin.patch('/api/admin/import-review/F990').send({ revision: initial.revision, status: 'reviewed',
      review: { ...decision, terms: { commRate: 8, psf: 2, psfDollars: 200, referralFee: 80, dealStatus: 'Paid In Full' } } });
    expect(saved.status).toBe(200);
    const preview = await admin.post('/api/admin/import-review/F990/preview').send({});
    expect(preview.body.problems).toEqual([]);
    expect(preview.body.deal).toMatchObject({ gross: 1000, psfPct: .02, referralFee: 80, referralRate: .08, net: 920, dealStatus: 'Paid In Full' });
    expect((await admin.post('/api/admin/import-review/F990/commit').send({ revision: saved.body.revision, previewToken: preview.body.previewToken })).status).toBe(201);
    expect((await repo.loadContext()).deals.find((d) => d.id === 'F990')).toMatchObject({ gross: 1000, psfPct: .02, referralFee: 80, net: 920, dealStatus: 'Paid In Full' });
  });

  it('preserves separate dates when a role was paid in installments without paying it again', async () => {
    const h = await setup();
    const saved = await h.reviewed({ ...decision, repPayments: [
      { repId: 'rep-leor', role: 'Opener', amount: 75, paidAt: '2025-01-19' },
      { repId: 'rep-leor', role: 'Opener', amount: 125, paidAt: '2025-01-20' },
    ] });
    const preview = await h.preview();
    expect(preview.body.problems).toEqual([]);
    expect(preview.body.payouts.map((p: { key: string }) => p.key)).toEqual([
      'F990|Opener|base|historical-partial', 'F990|Opener|base|historical-partial:2',
    ]);
    expect((await h.commit(saved.revision, preview.body.previewToken)).status).toBe(201);
    const ctx = await h.repo.loadContext();
    expect(ctx.lines.filter((l) => l.dealId === h.id)).toMatchObject([
      { amount: 75, paidAt: '2025-01-19' }, { amount: 125, paidAt: '2025-01-20' },
    ]);
    expect(payableLines(ctx.deals, ctx.lines, 'rep-leor').filter((l) => l.dealId === h.id)).toEqual([]);
    expect((await h.commit(saved.revision, preview.body.previewToken)).status).toBe(409);
  });

  it('rejects changed reviews, changed source and stale previews without writing money', async () => {
    const h = await setup();
    const saved = await h.reviewed();
    const pv = await h.preview();
    const newer = await h.admin.patch(`/api/admin/import-review/${h.id}`)
      .send({ revision: saved.revision, status: 'reviewed', review: { ...decision, notes: 'Checked again' } });
    expect(newer.status).toBe(200);
    expect((await h.commit(saved.revision, pv.body.previewToken)).status).toBe(409);
    expect((await h.repo.loadContext()).deals.some((d) => d.id === h.id)).toBe(false);
    await h.admin.post('/api/admin/import-review/stage').send({ csv: `${header}\n${row.replace('Acme', 'Acme LLC')}` });
    expect((await h.commit(newer.body.revision, pv.body.previewToken)).status).toBe(409);
  });

  it('blocks an existing deal with different funding economics rather than paying it twice', async () => {
    const h = await setup(row.replace('F990', 'F1'));
    await h.reviewed();
    const pv = await h.preview();
    expect(pv.body.problems.length).toBeGreaterThan(0);
    const before = await h.repo.loadContext();
    const attempt = await h.commit((await h.get()).revision, pv.body.previewToken);
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect((await h.repo.loadContext()).lines).toEqual(before.lines);
  });

  it('rejects aggregate-only historical pay claims until every rep is identified', async () => {
    const h = await setup();
    const item = await h.get();
    const response = await h.admin.patch(`/api/admin/import-review/${h.id}`).send({
      revision: item.revision, status: 'reviewed', review: { ...decision, repPayments: [] },
    });
    expect(response.status).toBe(400);
  });

  it('serializes simultaneous commits and never pays the same historical line twice', async () => {
    const h = await setup();
    const saved = await h.reviewed();
    const pv = await h.preview();
    const results = await Promise.all([h.commit(saved.revision, pv.body.previewToken), h.commit(saved.revision, pv.body.previewToken)]);
    expect(results.map((x) => x.status).sort()).toEqual([201, 409]);
    expect((await h.repo.loadContext()).lines.filter((x) => x.dealId === h.id)).toHaveLength(1);
    expect((await h.admin.post('/api/admin/import-review/stage').send({ csv: `${header}\n${row}` })).status).toBe(200);
    expect((await h.admin.get('/api/admin/import-review')).body.rows).toMatchObject([{ status: 'imported', sourceId: h.id }]);
    expect((await h.admin.post('/api/admin/import').send({ csv: `${header}\n${row}`, skipExisting: true })).status).toBe(409);
  });

  it('reconciles an exact paid line already on a live deal without appending it again', async () => {
    const source = 'F1,06/05/2026,F1 Business,MBC,MCA,10000,1.3,120,10%,1000,Julian Ribak,350,350,YES - Paid In Full,08/31/2026';
    const h = await setup(source);
    const reviewed = await h.reviewed({
      ...decision, lender: 'paid', lenderAmount: 1000, lenderDate: '2026-06-05',
      reps: 'paid', repAmount: 350, repDate: '2026-08-31',
      repPayments: [{ repId: 'rep-julian-ribak', role: 'Opener', amount: 350, paidAt: '2026-08-31' }],
    });
    const preview = await h.preview();
    expect(preview.body.payouts).toMatchObject([{ alreadyPosted: true }]);
    expect(preview.body.problems).toEqual([]);
    const before = (await h.repo.loadContext()).lines.length;
    expect((await h.commit(reviewed.revision, preview.body.previewToken)).status).toBe(201);
    expect((await h.repo.loadContext()).lines).toHaveLength(before);
  });

  it('posts a partially paid role once and leaves only its unpaid remainder for payroll', async () => {
    const h = await setup();
    const saved = await h.reviewed({ ...decision, lenderAmount: 1000, repAmount: 100,
      repPayments: [{ repId: 'rep-leor', role: 'Opener', amount: 100, paidAt: '2025-01-20' }] });
    const preview = await h.preview();
    expect(preview.body.problems).toEqual([]);
    expect(preview.body.payouts[0].key).toContain('|historical-partial');
    expect((await h.commit(saved.revision, preview.body.previewToken)).status).toBe(201);
    const context = await h.repo.loadContext();
    expect(context.lines.find((l) => l.dealId === h.id)?.amount).toBe(100);
    expect(payableLines(context.deals, context.lines, 'rep-leor').filter((l) => l.dealId === h.id)).toMatchObject([{ amount: 100 }]);
    expect(isDealFullyPaid(context.deals.find((d) => d.id === h.id)!, context.lines)).toBe(false);
    const remaining = payableLines(context.deals, context.lines, 'rep-leor').find((l) => l.dealId === h.id)!;
    const payout = planPayout(context, { repId: 'rep-leor', selectedKeys: [remaining.key], runId: 'run-next', paidAt: '2025-02-01' });
    expect(payout.lines.find((l) => l.dealId === h.id)?.amount).toBe(100);
    const paid = applyPayout(context, payout);
    expect(payableLines(paid.deals, paid.lines, 'rep-leor').filter((l) => l.dealId === h.id)).toEqual([]);
    expect(isDealFullyPaid(paid.deals.find((d) => d.id === h.id)!, paid.lines)).toBe(true);
    const voided = applyVoid(context, planVoid(context, { repId: 'rep-leor', runId: `import-review-${h.id}`, paidAt: '2025-02-01' }));
    expect(payableLines(voided.deals, voided.lines, 'rep-leor').filter((l) => l.dealId === h.id)).toMatchObject([{ amount: 200 }]);
    const historicalVoidedAfterRemainder = applyVoid(paid, planVoid(paid, { repId: 'rep-leor', runId: `import-review-${h.id}`, paidAt: '2025-02-02' }));
    expect(payableLines(historicalVoidedAfterRemainder.deals, historicalVoidedAfterRemainder.lines, 'rep-leor').filter((l) => l.dealId === h.id)).toMatchObject([{ amount: 100 }]);
    expect(isDealFullyPaid(historicalVoidedAfterRemainder.deals.find((d) => d.id === h.id)!, historicalVoidedAfterRemainder.lines)).toBe(false);
    expect(repDealView(historicalVoidedAfterRemainder.deals.find((d) => d.id === h.id)!, 'rep-leor', historicalVoidedAfterRemainder.lines).lines[0]?.paidAmount).toBe(100);
    const reoffer = payableLines(historicalVoidedAfterRemainder.deals, historicalVoidedAfterRemainder.lines, 'rep-leor').find((l) => l.dealId === h.id)!;
    const repaid = applyPayout(historicalVoidedAfterRemainder, planPayout(historicalVoidedAfterRemainder,
      { repId: 'rep-leor', selectedKeys: [reoffer.key], runId: 'run-repay', paidAt: '2025-02-04' }));
    expect(isDealFullyPaid(repaid.deals.find((d) => d.id === h.id)!, repaid.lines)).toBe(true);
    const remainderVoided = applyVoid(paid, planVoid(paid, { repId: 'rep-leor', runId: 'run-next', paidAt: '2025-02-03' }));
    expect(payableLines(remainderVoided.deals, remainderVoided.lines, 'rep-leor').filter((l) => l.dealId === h.id)).toMatchObject([{ amount: 100 }]);
  });

  it('rolls back deal, collection, ledger, run, and review status if a late commit step fails', async () => {
    const h = await setup();
    const saved = await h.reviewed();
    const preview = await h.preview();
    const before = await h.repo.loadContext();
    const runs = await h.repo.listRuns();
    h.repo.writeAudit = async () => { throw new Error('audit unavailable'); };
    expect((await h.commit(saved.revision, preview.body.previewToken)).status).toBe(500);
    expect(await h.repo.loadContext()).toEqual(before);
    expect(await h.repo.listRuns()).toEqual(runs);
    expect((await h.get()).status).toBe('reviewed');
  });

  it('posts an exact scheduled receipt count rather than inferring a partial percentage', async () => {
    const source = 'F992,01/10/2025,Scheduled,GFE,CONSOLIDATION - UPFRONT COMM,10000,1.3,120,10%,1000,Leor,200,200,Partially Paid,';
    const h = await setup(source);
    const saved = await h.reviewed({
      ...decision, lenderAmount: 100, lenderWeeks: 2, reps: 'unpaid', repAmount: null, repDate: null, repPayments: [],
    });
    const pv = await h.preview();
    expect(pv.body.problems).toEqual([]);
    expect((await h.commit(saved.revision, pv.body.previewToken)).status).toBe(201);
    const actual = (await h.repo.loadContext()).deals.find((x) => x.id === 'F992')!;
    expect(actual.commSchedule?.received).toBe(2);
    expect(actual.commSchedule?.confirmedDates?.['1']).toBe('2025-01-15');
    const zero = await setup(source.replace('F992', 'F997'));
    await zero.reviewed({ ...decision, lenderAmount: 100, lenderWeeks: 0, reps: 'unpaid', repAmount: null, repDate: null, repPayments: [] });
    expect((await zero.preview()).body.problems).toContain('A positive scheduled receipt requires at least one confirmed week.');
    expect((await zero.repo.loadContext()).deals.some((d) => d.id === 'F997')).toBe(false);
  });

  it('imports a verified draw under its existing parent without creating a second deal', async () => {
    const h = await setup('F993,01/10/2025,Facility,MBC,LOC - INITIAL,10000,,120,8%,800,Leor,160,160,Waiting for payment,');
    const parent = await h.reviewed({ ...decision, lender: 'unpaid', lenderAmount: null, lenderDate: null, reps: 'unpaid', repAmount: null, repDate: null, repPayments: [] });
    const parentPreview = await h.preview();
    expect(parentPreview.body.problems).toEqual([]);
    expect((await h.commit(parent.revision, parentPreview.body.previewToken)).status).toBe(201);
    const drawHeader = header.replace('Deal ID,Date', 'Deal ID,Parent Deal,Date');
    const drawRow = 'F994,,02/10/2025,Facility,MBC,LOC DRAW,2000,,120,4%,80,Leor,16,16,Partially Paid,';
    expect((await h.admin.post('/api/admin/import-review/stage').send({ csv: `${drawHeader}\n${drawRow}` })).status).toBe(200);
    const current = (await h.admin.get('/api/admin/import-review')).body.rows[0];
    const saved = await h.admin.patch('/api/admin/import-review/F994').send({ revision: current.revision, status: 'reviewed',
      review: { ...decision, lenderAmount: 40, reps: 'unpaid', repAmount: null, repDate: null, repPayments: [], terms: { parent: 'F993' } } });
    expect(saved.status).toBe(200);
    const pv = await h.admin.post('/api/admin/import-review/F994/preview').send({});
    expect(pv.body.problems).toEqual([]);
    expect(pv.body.action).toBe('draw');
    expect((await h.admin.post('/api/admin/import-review/F994/commit').send({ revision: saved.body.revision, previewToken: pv.body.previewToken })).status).toBe(201);
    const context = await h.repo.loadContext();
    expect(context.deals.some((x) => x.id === 'F994')).toBe(false);
    expect(context.deals.find((x) => x.id === 'F993')?.draws).toMatchObject([{ amount: 2000, collected: 40 }]);
    const wrongSourceParent = drawRow.replace('F994,,02/10/2025', 'F995,F999,03/10/2025')
      .replace('LOC DRAW,2000,,120,4%,80,Leor,16,16', 'LOC DRAW,3000,,120,4%,120,Leor,24,24');
    await h.admin.post('/api/admin/import-review/stage').send({ csv: `${drawHeader}\n${wrongSourceParent}` });
    const second = (await h.admin.get('/api/admin/import-review')).body.rows[0];
    const corrected = await h.admin.patch('/api/admin/import-review/F995').send({ revision: second.revision, status: 'reviewed',
      review: { ...decision, lenderAmount: 60, reps: 'unpaid', repAmount: null, repDate: null, repPayments: [], terms: { parent: 'F993' } } });
    expect(corrected.status).toBe(200);
    const secondPreview = await h.admin.post('/api/admin/import-review/F995/preview').send({});
    expect(secondPreview.body.problems).toEqual([]);
    expect((await h.admin.post('/api/admin/import-review/F995/commit').send({ revision: corrected.body.revision, previewToken: secondPreview.body.previewToken })).status).toBe(201);
    expect((await h.repo.loadContext()).deals.find((x) => x.id === 'F993')?.draws).toHaveLength(2);
  });

  it('imports a source clawback with its actual date and blocks a missing date', async () => {
    const clawHeader = `${header},Clawback $,Clawback Date`;
    const h = await setup();
    const source = row.replace('F990', 'F995');
    const staged = await h.admin.post('/api/admin/import-review/stage').send({ csv: `${clawHeader}\n${source},50,02/01/2025` });
    expect(staged.status).toBe(200);
    const current = (await h.admin.get('/api/admin/import-review')).body.rows[0];
    const saved = await h.admin.patch('/api/admin/import-review/F995').send({ revision: current.revision, status: 'reviewed', review: decision });
    expect(saved.status).toBe(200);
    const preview = await h.admin.post('/api/admin/import-review/F995/preview').send({});
    expect(preview.body.clawback).toMatchObject({ amount: 50, date: '2025-02-01' });
    expect(preview.body.problems).toEqual([]);
    expect((await h.admin.post('/api/admin/import-review/F995/commit').send({ revision: saved.body.revision, previewToken: preview.body.previewToken })).status).toBe(201);
    expect((await h.repo.loadContext()).clawbacks).toEqual(expect.arrayContaining([expect.objectContaining({ dealId: 'F995', amount: 50, date: '2025-02-01' })]));

    const next = await setup(row.replace('F990', 'F996'));
    await next.admin.post('/api/admin/import-review/stage').send({ csv: `${clawHeader}\n${row.replace('F990', 'F996')},50,` });
    await next.reviewed();
    expect((await next.preview()).body.problems).toContain('Confirm the actual clawback date; the funding date is not a substitute.');
  });
});