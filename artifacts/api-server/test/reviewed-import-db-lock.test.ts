import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from '@greystone/db';

const snapshotEnd = (value: string) => Number(value.split(':')[1]);

describe('reviewed import and payroll concurrency', () => {
  it('uses a new statement snapshot after waiting for payroll-rep locks', () => {
    const source = readFileSync(new URL('../src/repo.db.ts', import.meta.url), 'utf8');
    const commit = source.slice(source.indexOf('async commitReviewedImport('), source.indexOf('async listJournals('));
    expect(commit).toContain("isolationLevel: 'read committed'");
    expect(commit.indexOf('pg_advisory_xact_lock')).toBeLessThan(commit.indexOf('await plan(txRepo)'));
  });

  it.skipIf(!process.env.DATABASE_URL)('sees a payout committed while the import waits for a rep lock (PostgreSQL)', async () => {
    const holder = createDb();
    const importer = createDb();
    const connection = await holder.$client.reserve();
    const key = `reviewed-import-lock-test:${process.pid}:${Date.now()}`;
    let unlock = false;
    try {
      await connection`select pg_advisory_lock(hashtext(${key}))`;
      unlock = true;
      let ready!: () => void;
      const waiting = new Promise<void>((resolve) => { ready = resolve; });
      const importTransaction = importer.transaction(async (tx) => {
        const before = await tx.execute(sql<{ snapshot: string }>`select txid_current_snapshot()::text as snapshot`);
        ready();
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
        const after = await tx.execute(sql<{ snapshot: string }>`select txid_current_snapshot()::text as snapshot`);
        return { before: String(before[0]!.snapshot), after: String(after[0]!.snapshot) };
      }, { isolationLevel: 'read committed' });
      await waiting;
      const rows = await connection`select txid_current()::text as id`;
      const paidTransactionId = Number(rows[0]!.id);
      await connection`select pg_advisory_unlock(hashtext(${key}))`;
      unlock = false;
      const { before, after } = await importTransaction;
      expect(snapshotEnd(before)).toBeLessThanOrEqual(paidTransactionId);
      expect(snapshotEnd(after)).toBeGreaterThan(paidTransactionId);
    } finally {
      if (unlock) await connection`select pg_advisory_unlock(hashtext(${key}))`;
      connection.release();
      await Promise.all([holder.$client.end(), importer.$client.end()]);
    }
  });
});