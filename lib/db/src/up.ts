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
type CatalogCheck = { kind: 'constraint' | 'trigger' | 'index' | 'function' | 'account' | 'view' | 'column'; name: string; table?: string; value?: string; constraintType?: 'c' | 'f' | 'x'; unique?: boolean };
type Fingerprint = { table: string; column?: string } | { checks: CatalogCheck[] };
const FINGERPRINTS: Record<string, Fingerprint> = {
  '0000_commission_portal_phase1': { table: 'commission_deals' },
  '0001_audit_log': { table: 'commission_audit_log' },
  '0002_draw_terms': { table: 'commission_deal_draws', column: 'term_days' },
  '0003_rep_passwords': { table: 'commission_reps', column: 'password_hash' },
  '0004_payout_voids': { table: 'commission_payout_lines', column: 'voids' },
  '0005_launch_notes_files_2fa': { table: 'commission_deal_notes' },
  '0006_loc_line_fee': { table: 'commission_deals', column: 'line_fee' },
  '0007_audit_ip': { table: 'commission_audit_log', column: 'ip' },
  '0008_session_cutoff_bookkeeping': { table: 'commission_reps', column: 'session_cutoff' },
  '0009_trusted_devices': { table: 'commission_trusted_devices' },
  '0010_super_admin_perms': { table: 'commission_reps', column: 'super_admin' },
  '0011_rep_commission_eligible': { table: 'commission_reps', column: 'commission_eligible' },
  '0012_unified_accounting_books': { table: 'commission_journals' },
  '0013_accounting_journal_dimensions': { table: 'commission_journal_lines', column: 'deal_id' },
  '0014_accounting_integrity': { checks: [
    { kind: 'constraint', table: 'commission_accounting_periods', name: 'commission_accounting_period_status', constraintType: 'c' },
    { kind: 'constraint', table: 'commission_accounting_periods', name: 'commission_accounting_period_no_overlap', constraintType: 'x' },
    { kind: 'constraint', table: 'commission_reconciliations', name: 'commission_reconciliation_status', constraintType: 'c' },
    { kind: 'constraint', table: 'commission_reconciliation_matches', name: 'commission_reconciliation_match_nonzero', constraintType: 'c' },
    { kind: 'trigger', table: 'commission_journal_lines', name: 'commission_journal_balance' },
    { kind: 'trigger', table: 'commission_journals', name: 'commission_reject_closed_period_journal' },
  ] },
  '0015_rep_recovery_receivable': { checks: [
    { kind: 'account', name: '1200', value: 'rep_recovery_receivable' },
    { kind: 'index', table: 'commission_reconciliation_matches', name: 'commission_reconciliation_matches_line_unique_idx', unique: true },
  ] },
  '0016_accounting_correction_chains': { checks: [
    { kind: 'column', table: 'commission_journals', name: 'logical_source_key' },
    { kind: 'constraint', table: 'commission_journals', name: 'commission_journals_reversal_of_fk', constraintType: 'f' },
    { kind: 'index', table: 'commission_journals', name: 'commission_journals_logical_version_kind_idx', unique: true },
    { kind: 'trigger', table: 'commission_journals', name: 'commission_journal_has_lines' },
    { kind: 'column', table: 'commission_accounting_source_chains', name: 'effective_journal_id' },
  ] },
  '0017_journal_lifecycle_deal_tombstones': { checks: [
    { kind: 'column', table: 'commission_journals', name: 'posting_status' },
    { kind: 'constraint', table: 'commission_journals', name: 'commission_journals_posting_status', constraintType: 'c' },
    { kind: 'trigger', table: 'commission_journals', name: 'commission_protect_journal_header' },
    { kind: 'trigger', table: 'commission_journal_lines', name: 'commission_protect_journal_lines' },
    { kind: 'trigger', table: 'commission_journals', name: 'commission_journal_must_be_sealed' },
    { kind: 'function', name: 'commission_seal_journal' },
    { kind: 'column', table: 'commission_deals', name: 'deleted_at' },
    { kind: 'index', table: 'commission_deals', name: 'commission_deals_active_idx' },
    { kind: 'view', name: 'commission_operational_deals' },
  ] },
  '0018_reconciliation_statements': { table: 'commission_reconciliations', column: 'opening_balance' },
  '0019_clawback_forgiveness': { table: 'commission_clawbacks', column: 'forgiven_at' },
  '0020_sheets_sync_operations': { table: 'commission_sheets_sync_operations' },
  '0021_sheets_sync_operations_repair': { checks: [
    { kind: 'column', table: 'commission_sheets_sync_operations', name: 'state' },
    { kind: 'index', table: 'commission_sheets_sync_operations', name: 'commission_sheets_sync_operations_key_idx', unique: true },
  ] },
  '0022_wallet_adjustments': { checks: [
    { kind: 'constraint', table: 'commission_wallet_adjustments', name: 'commission_wallet_adjustments_reversal_of_fkey', constraintType: 'f' },
    { kind: 'account', name: '5020', value: 'wallet_adjustment' },
  ] },
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
  const hasCatalogCheck = async (check: CatalogCheck): Promise<boolean> => {
    if (check.kind === 'column') return exists(check.table!, check.name);
    let rows;
    if (check.kind === 'constraint') rows = await db.execute(sql`select 1 from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and r.relname=${check.table!} and c.conname=${check.name} and (${check.constraintType ?? null}::text is null or c.contype::text=${check.constraintType ?? null}) limit 1`);
    else if (check.kind === 'trigger') rows = await db.execute(sql`select 1 from pg_trigger t join pg_class r on r.oid=t.tgrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and r.relname=${check.table!} and t.tgname=${check.name} and not t.tgisinternal and t.tgenabled <> 'D' limit 1`);
    else if (check.kind === 'index') rows = await db.execute(sql`select 1 from pg_class i join pg_index x on x.indexrelid=i.oid join pg_class r on r.oid=x.indrelid join pg_namespace n on n.oid=r.relnamespace where n.nspname='public' and r.relname=${check.table!} and i.relname=${check.name} and (${check.unique ?? null}::boolean is null or x.indisunique=${check.unique ?? null}) limit 1`);
    else if (check.kind === 'function') rows = await db.execute(sql`select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${check.name} limit 1`);
    else if (check.kind === 'account') rows = await db.execute(sql`select 1 from commission_accounts where code=${check.name} and purpose=${check.value!} limit 1`);
    else rows = await db.execute(sql`select 1 from information_schema.views where table_schema='public' and table_name=${check.name} limit 1`);
    return rows.length > 0;
  };
  const fingerprintExists = async (fp: Fingerprint): Promise<boolean> =>
    'checks' in fp ? (await Promise.all(fp.checks.map(hasCatalogCheck))).every(Boolean) : exists(fp.table, fp.column);
  await db.execute(sql`create schema if not exists "drizzle"`);
  await db.execute(sql`create table if not exists "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)`);
  const ledger = await db.execute(sql`select count(*)::int as n from "drizzle"."__drizzle_migrations"`);
  const baselined: string[] = [];
  if (Number((ledger[0] as { n: number }).n) === 0 && (await exists('commission_deals'))) {
    // Push-built database: record every migration whose effect is already here, stopping at the first that is not.
    for (const e of readJournal(dir)) {
      const fp = FINGERPRINTS[e.tag];
      if (!fp || !(await fingerprintExists(fp))) break;
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
