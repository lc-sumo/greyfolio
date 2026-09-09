import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { memoryRepo } from './memory-repo.js';

const secret = 'sync-test-secret';
const config = configFromEnv({ AUTH_MODE: 'dev', SESSION_SECRET: 'x'.repeat(32), SHEETS_SYNC_SECRET: secret, PORT: '0' });
const headers = 'Deal ID,Parent Deal,Date,Business Name,Lender,Product,Funded / Draw Amount ($),Factor Rate,Term (bus. days),Frequency,Comm %,Opener,Closer,Override Rep,Commission Status,Lender Paid Date,Deal Status,Notes,Lead Source';
const newCsv = `${headers}\n, ,2026-01-05,Sync New,MBC,MCA,10000,1.3,120,Daily,10,Julian Ribak,Zach Sanders,Raymond Amato,NO,,Performing,,Sheet`;
const stableCsv = newCsv.replace('\n, ,', '\n gs-12345678 , gs-12345678 ,');
const auth = (r: request.Test, spreadsheet = 'sheet-test-123') => r.set('X-Sheets-Sync-Secret', secret).set('X-Sheets-Spreadsheet-Id', spreadsheet);

async function harness() {
  const repo = memoryRepo();
  repo.data.reps.push({ id: 'rep-lc', name: 'LC', email: 'lc@greystoneus.com', role: 'admin', teamId: null, openerRate: .2, closerRate: .2, overrideRate: .05, active: true, superAdmin: true });
  return { repo, app: createApp(config, repo) };
}

describe('Google Sheets sync', () => {
  it('rejects missing and incorrect secrets', async () => {
    const { app } = await harness();
    expect((await request(app).get('/api/sync/master-deals')).status).toBe(401);
    expect((await request(app).get('/api/sync/master-deals').set('X-Sheets-Sync-Secret', 'wrong')).status).toBe(401);
  });

  it('binds the first spreadsheet and denies another spreadsheet', async () => {
    const { app } = await harness();
    expect((await auth(request(app).get('/api/sync/master-deals'), 'first-sheet-123')).status).toBe(200);
    expect((await auth(request(app).get('/api/sync/master-deals'), 'second-sheet-123')).status).toBe(403);
  });

  it('pulls complete importer headers and draw rows with stable parent identity', async () => {
    const { app, repo } = await harness();
    const first = repo.data.deals[0]!;
    first.draws.push({ n: 1, ref: 'D1', date: '2026-07-01', amount: 1000, commRate: .1, gross: 100, referralFee: 0, net: 100, collected: 0, schedule: null });
    const response = await auth(request(app).get('/api/sync/master-deals'));
    expect(response.status).toBe(200);
    expect(response.body.headers).toContain('Funded / Draw Amount ($)');
    expect(response.body.headers.length).toBeGreaterThanOrEqual(46);
    const child = response.body.rows.find((r: string[]) => r[0] === 'F1-D1');
    expect(child?.[1]).toBe('F1');
    expect(child?.[6]).toBe(1000);
    expect(response.body.editableColumns).toContain('Deal Status');
    const roundTrip = [response.body.headers, ...response.body.rows]
      .map((r: string[]) => r.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
    const preview = await auth(request(app).post('/api/sync/master-deals').query({ preview: 'true' })).send({ csv: roundTrip });
    expect(preview.status).toBe(200);
    expect(preview.body.rows.some((r: { action: string; parentId: string | null }) => (r.action === 'draw' || r.action === 'skip') && r.parentId === 'F1')).toBe(true);
  });

  it('pushes a new deal through the safe importer and safely updates an existing deal', async () => {
    const { app, repo } = await harness();
    const pushed = await auth(request(app).post('/api/sync/master-deals').set('X-Sheets-Idempotency-Key', 'new-1')).send({ csv: newCsv, operationKey: 'new-1' });
    expect(pushed.status).toBe(200);
    expect(repo.data.deals.some((d) => d.business === 'Sync New')).toBe(true);
    const update = `${headers}\nF1,F1,2026-06-05,F1 Business,MBC,MCA,10000,1.3,120,Daily,10,,,,NO,2026-06-10,Default,,`;
    const changed = await auth(request(app).post('/api/sync/master-deals').set('X-Sheets-Idempotency-Key', 'update-1')).send({ csv: update, operationKey: 'update-1' });
    expect(changed.status).toBe(200);
    expect(repo.data.deals.find((d) => d.id === 'F1')?.dealStatus).toBe('Default');
    expect(repo.data.deals.find((d) => d.id === 'F1')?.funded).toBe(10000);
  });

  it('accepts a sheet-assigned stable new-deal id and replays without duplication', async () => {
    const { app, repo } = await harness();
    const body = { csv: stableCsv, operationKey: 'stable-create' };
    expect((await auth(request(app).post('/api/sync/master-deals')).send(body)).status).toBe(200);
    expect(repo.data.deals.filter((d) => d.id === 'GS-12345678')).toHaveLength(1);
    expect((await auth(request(app).post('/api/sync/master-deals')).send(body)).status).toBe(200);
    expect(repo.data.deals.filter((d) => d.id === 'GS-12345678')).toHaveLength(1);
  });

  it('pushes remittance and replays sequentially and concurrently without duplicate mutation', async () => {
    const { app, repo } = await harness();
    const csv = 'Deal ID,Date,Amount\nF2,2026-08-01,10';
    const body = { csv, operationKey: 'remit-1' };
    const first = await auth(request(app).post('/api/sync/remittance').set('X-Sheets-Idempotency-Key', 'remit-1')).send(body);
    expect(first.status).toBe(200);
    const auditsAfterFirst = repo.audit.filter((a) => a.action === 'deal.remittance').length;
    const second = await auth(request(app).post('/api/sync/remittance').set('X-Sheets-Idempotency-Key', 'remit-1')).send(body);
    expect(second.status).toBe(200);
    expect(repo.audit.filter((a) => a.action === 'deal.remittance').length).toBe(auditsAfterFirst);
    const concurrentKey = 'remit-concurrent';
    const results = await Promise.all([1, 2, 3].map(() => auth(request(app).post('/api/sync/remittance').set('X-Sheets-Idempotency-Key', concurrentKey)).send({ ...body, operationKey: concurrentKey })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(repo.audit.filter((a) => a.action === 'deal.remittance').length).toBe(auditsAfterFirst + 1);
  });

  it('replays a completed receipt before current-balance preview after it closes the deal', async () => {
    const { app, repo } = await harness();
    const csv = 'Receipt ID,Deal ID,Date,Amount\nclose-f2,F2,2026-08-01,2000';
    const body = { csv, operationKey: 'remittance-close-f2' };
    const first = await auth(request(app).post('/api/sync/remittance')).send(body);
    expect(first.status).toBe(200);
    const count = repo.audit.filter((a) => a.action === 'deal.remittance').length;
    const retry = await auth(request(app).post('/api/sync/remittance')).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(repo.audit.filter((a) => a.action === 'deal.remittance')).toHaveLength(count);
  });

  it('serializes distinct receipts on one deal as exact deltas without overwriting', async () => {
    const { app, repo } = await harness();
    const make = (id: string) => auth(request(app).post('/api/sync/remittance')).send({ csv: `Receipt ID,Deal ID,Date,Amount\n${id},F2,2026-08-01,10`, operationKey: `remittance-${id}` });
    const results = await Promise.all([make('delta-a'), make('delta-b')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(repo.data.deals.find((d) => d.id === 'F2')?.commCollected).toBe(20);
  });

  it('applies and safely replays an exact single-segment scheduled receipt', async () => {
    const { app, repo } = await harness();
    const deal = repo.data.deals.find((d) => d.id === 'F2')!;
    deal.commCollected = null;
    deal.commSchedule = { mode: 'weekly', weeks: 10, received: 0, startDate: '2026-08-01', remainder: 'spread' };
    const badCsv = 'Receipt ID,Deal ID,Date,Amount\nscheduled-one,F2,2026-08-01,199';
    const bad = await auth(request(app).post('/api/sync/remittance')).send({ csv: badCsv, operationKey: 'remittance-scheduled-one' });
    expect(bad.status).toBe(400);
    expect(repo.data.deals.find((d) => d.id === 'F2')!.commSchedule?.received).toBe(0);
    expect(repo.audit.filter((a) => a.action === 'deal.remittance')).toHaveLength(0);
    const csv = 'Receipt ID,Deal ID,Date,Amount\nscheduled-one,F2,2026-08-01,200';
    const body = { csv, operationKey: 'remittance-scheduled-one' };
    const first = await auth(request(app).post('/api/sync/remittance')).send(body);
    expect(first.status).toBe(200);
    expect(repo.data.deals.find((d) => d.id === 'F2')!.commSchedule?.received).toBe(1);
    const retry = await auth(request(app).post('/api/sync/remittance')).send(body);
    expect(retry.status).toBe(200);
    expect(repo.data.deals.find((d) => d.id === 'F2')!.commSchedule?.received).toBe(1);
    expect(repo.audit.filter((a) => a.action === 'deal.remittance')).toHaveLength(1);
  });

  it('rejects reusing a key with different payload', async () => {
    const { app } = await harness();
    const one = await auth(request(app).post('/api/sync/master-deals').set('X-Sheets-Idempotency-Key', 'hash-1')).send({ csv: newCsv, operationKey: 'hash-1' });
    expect(one.status).toBe(200);
    const two = await auth(request(app).post('/api/sync/master-deals').set('X-Sheets-Idempotency-Key', 'hash-1')).send({ csv: newCsv.replace('Sync New', 'Different'), operationKey: 'hash-1' });
    expect(two.status).toBe(409);
  });

  it('allows equal legitimate receipts with distinct receipt ids and conflicts when one id changes payload', async () => {
    const { app, repo } = await harness();
    const csv = 'Receipt ID,Deal ID,Date,Amount\nreceipt-a,F2,2026-08-01,10';
    expect((await auth(request(app).post('/api/sync/remittance')).send({ csv, operationKey: 'remittance-receipt-a' })).status).toBe(200);
    expect((await auth(request(app).post('/api/sync/remittance')).send({ csv: csv.replace('receipt-a', 'receipt-b'), operationKey: 'remittance-receipt-b' })).status).toBe(200);
    expect(repo.audit.filter((a) => a.action === 'deal.remittance')).toHaveLength(2);
    expect((await auth(request(app).post('/api/sync/remittance')).send({ csv: csv.replace(',10', ',11'), operationKey: 'remittance-receipt-a' })).status).toBe(409);
  });

  it('rejects partially applicable remittance before claiming or mutating', async () => {
    const { app, repo } = await harness();
    const bad = 'Receipt ID,Deal ID,Date,Amount\npartial,F2,2026-08-01,999999';
    expect((await auth(request(app).post('/api/sync/remittance')).send({ csv: bad, operationKey: 'remittance-partial' })).status).toBe(400);
    expect(repo.audit.filter((a) => a.action === 'deal.remittance')).toHaveLength(0);
    const good = 'Receipt ID,Deal ID,Date,Amount\npartial,F2,2026-08-01,10';
    expect((await auth(request(app).post('/api/sync/remittance')).send({ csv: good, operationKey: 'remittance-partial' })).status).toBe(200);
  });

  it('keeps failed and processing claims instead of rerunning money work', async () => {
    const { repo } = await harness();
    await expect(repo.runSyncAtMostOnce('test', 'failed', 'hash', async () => { throw new Error('uncertain'); })).rejects.toThrow('uncertain');
    const failed = await repo.runSyncAtMostOnce('test', 'failed', 'hash', async () => ({ status: 200, response: { rerun: true } }));
    expect(failed.status).toBe(500);
    const processing = await repo.runSyncAtMostOnce('test', 'processing', 'hash', async () => ({ status: 200, response: {} }));
    expect(processing.status).toBe(200);
    const replay = await repo.runSyncAtMostOnce('test', 'processing', 'hash', async () => ({ status: 200, response: { rerun: true } }));
    expect(replay.replayed).toBe(true);
  });
});