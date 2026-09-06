/**
 * Bring the database to the current schema safely:
 *
 *   DATABASE_URL=postgres://… pnpm --filter @greystone/db up
 *
 * A database that was created with `drizzle-kit push` has the tables but no
 * migration ledger. Rather than re-running (and failing on) migrations whose
 * effects already exist, `up` first records as applied every migration whose
 * fingerprint — a table or column it introduced — is already present, then
 * runs the migrator for the rest. From then on only additive, reviewed
 * migration files change production; nothing is ever dropped by surprise.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createDb } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../migrations');

/** What each migration introduced, so a push-built database can be matched to the ledger. */
const FINGERPRINTS: Record<string, { table: string; column?: string }> = {
  '0000_commission_portal_phase1': { table: 'commission_deals' },
  '0001_audit_log': { table: 'commission_audit_log' },
  '0002_draw_terms': { table: 'commission_deal_draws', column: 'term_days' },
  '0003_rep_passwords': { table: 'commission_reps', column: 'password_hash' },
  '0004_payout_voids': { table: 'commission_payout_lines', column: 'voids' },
  '0005_launch_notes_files_2fa': { table: 'commission_deal_notes' },
  '0006_loc_line_fee': { table: 'commission_deals', column: 'line_fee' },
  '0007_audit_ip': { table: 'commission_audit_log', column: 'ip' },
  '0008_session_cutoff_bookkeeping': { table: 'commission_reps', column: 'session_cutoff' },
};

interface JournalEntry { idx: number; when: number; tag: string }

export function readJournal(dir = MIGRATIONS_DIR): JournalEntry[] {
  const j = JSON.parse(readFileSync(path.join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
  return j.entries;
}

/** Same fingerprint the drizzle migrator stores: sha256 of the migration file. */
export function migrationHash(dir: string, tag: string): string {
  return createHash('sha256').update(readFileSync(path.join(dir, `${tag}.sql`), 'utf8')).digest('hex');
}

export async function up(db: ReturnType<typeof createDb>, dir = MIGRATIONS_DIR): Promise<{ baselined: string[]; migrated: boolean }> {
  const exists = async (table: string, column?: string): Promise<boolean> => {
    const rows = column
      ? await db.execute(sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = ${column} limit 1`)
      : await db.execute(sql`select 1 from information_schema.tables where table_schema = 'public' and table_name = ${table} limit 1`);
    return rows.length > 0;
  };
  await db.execute(sql`create schema if not exists "drizzle"`);
  await db.execute(sql`create table if not exists "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)`);
  const ledger = await db.execute(sql`select count(*)::int as n from "drizzle"."__drizzle_migrations"`);
  const baselined: string[] = [];
  if (Number((ledger[0] as { n: number }).n) === 0 && (await exists('commission_deals'))) {
    // Push-built database: record every migration whose effect is already here, stopping at the first that is not.
    for (const e of readJournal(dir)) {
      const fp = FINGERPRINTS[e.tag];
      if (!fp || !(await exists(fp.table, fp.column))) break;
      await db.execute(sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at) values (${migrationHash(dir, e.tag)}, ${e.when})`);
      baselined.push(e.tag);
    }
  }
  await migrate(db, { migrationsFolder: dir });
  return { baselined, migrated: true };
}

const isMain = process.argv[1] && /up\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const db = createDb();
  up(db)
    .then(async (r) => {
      if (r.baselined.length) console.log(`Baselined ${r.baselined.length} migrations already present: ${r.baselined.join(', ')}`);
      console.log('Database is at the current schema');
      await db.$client.end();
    })
    .catch(async (err) => {
      console.error(err);
      await db.$client.end();
      process.exit(1);
    });
}
