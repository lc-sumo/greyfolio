/**
 * Commission portal schema (Postgres via Drizzle).
 *
 * The handoff README describes an existing `commission_*` schema in the
 * Greystone code package (deals, reps, payments, clawbacks, payroll runs,
 * sheets-sync state, a QuickBooks flag). That package is not in this repo,
 * so this file defines the full tables: the columns the README lists as
 * "existing" plus the Phase 1 additions from "Schema Changes Required".
 * When the original package is available, diff its `commission.ts` against
 * this one and keep its column names where they differ — see
 * docs/PHASE-1-REVIEW.md.
 *
 * Conventions
 *  - Money: numeric(14,2), read as JS numbers (dollars, cents precision).
 *  - Rates: numeric(7,5) fractions (0.20 = 20%).
 *  - Dates: `date` columns read as `YYYY-MM-DD` strings; the domain layer is timezone-free.
 *  - Derived quantities (commission status, owed, house net) are NOT stored.
 *    Stored gross/referral_fee/net are the outputs of `commissionFor` at write time,
 *    exactly as the workbook stores its formula results.
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { Lender, ProductRule, ReferralPartner, WeeklySchedule } from '@greystone/commission';

const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: 'number' });
const rate = (name: string) => numeric(name, { precision: 7, scale: 5, mode: 'number' });
const isoDate = (name: string) => date(name, { mode: 'string' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ */
/* Teams and reps                                                      */
/* ------------------------------------------------------------------ */

export const commissionTeams = pgTable('commission_teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  leaderRepId: text('leader_rep_id').references((): AnyPgColumn => commissionReps.id, { onDelete: 'set null' }),
  /** Team-level override rate, used when the leader's profile has none. */
  overrideRate: rate('override_rate').notNull().default(0.05),
  createdAt: createdAt(),
});

export const commissionReps = pgTable(
  'commission_reps',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    /** rep | manager | admin — Phase 2 wires this to OIDC. */
    role: text('role').notNull().default('rep'),
    openerRate: rate('opener_rate').notNull().default(0.2),
    closerRate: rate('closer_rate').notNull().default(0.2),
    // Phase 1 additions
    /** Null → fall back to the team's override rate. */
    overrideRate: rate('override_rate'),
    teamId: text('team_id').references(() => commissionTeams.id, { onDelete: 'set null' }),
    /** Deactivating a rep must not alter historical assignments (invariant #9). */
    active: boolean('active').notNull().default(true),
    /** Portal-only identities are not eligible for opener, closer, or override splits. */
    commissionEligible: boolean('commission_eligible').notNull().default(true),
    /** scrypt hash for email + password sign-in; null = SSO / no password set. Never leaves the API. */
    passwordHash: text('password_hash'),
    /** Base32 TOTP secret for two-factor sign-in; null = not enrolled. Enabled only once a code has been verified. */
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    /** Sessions issued before this instant are refused — set when a password changes. */
    sessionCutoff: timestamp('session_cutoff', { withTimezone: true }),
    /** Secret in the rep's private calendar-feed URL; null = feed off. */
    calendarToken: text('calendar_token'),
    /** Owner tier: creates and changes admins, changes security settings. */
    superAdmin: boolean('super_admin').notNull().default(false),
    /** Per-rep permission switches ({ merchantEmail?: boolean }). */
    perms: jsonb('perms').$type<{ merchantEmail?: boolean } | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('commission_reps_email_idx').on(t.email)],
);

/* ------------------------------------------------------------------ */
/* Deals and draws                                                     */
/* ------------------------------------------------------------------ */

export const commissionDeals = pgTable(
  'commission_deals',
  {
    /** `F1`, `F2`, … — the sheet's `="F"&COUNT(...)` series. */
    id: text('id').primaryKey(),
    /** Funded date. Never in the future — rejected at entry (invariant #8). */
    date: isoDate('date').notNull(),
    business: text('business').notNull(),
    lender: text('lender').notNull(),
    product: text('product').notNull(),
    funded: money('funded').notNull(),
    factor: numeric('factor', { precision: 8, scale: 4, mode: 'number' }),
    termDays: integer('term_days'),
    payback: money('payback'),
    commRate: rate('comm_rate').notNull(),
    referralPartner: text('referral_partner'),
    referralRate: rate('referral_rate').notNull().default(0),
    /** Outputs of `commissionFor` on the initial segment, stored at write time. */
    gross: money('gross').notNull(),
    referralFee: money('referral_fee').notNull().default(0),
    net: money('net').notNull(),
    openerId: text('opener_id').references(() => commissionReps.id),
    openerRate: rate('opener_rate').notNull().default(0),
    closerId: text('closer_id').references(() => commissionReps.id),
    closerRate: rate('closer_rate').notNull().default(0),
    /** The team leader's cut. "Override" is the workbook's term — use it everywhere. */
    overrideId: text('override_id').references(() => commissionReps.id),
    overrideRate: rate('override_rate').notNull().default(0),
    dealStatus: text('deal_status').notNull().default('Performing'),
    /** Stamped only when every role line on every segment is in the ledger. */
    repPaid: isoDate('rep_paid'),
    lenderPaid: isoDate('lender_paid'),
    leadSource: text('lead_source'),
    notes: text('notes'),
    // Phase 1 additions (README → "Schema Changes Required")
    /** Groups multi-funding facilities; defaults to own id. */
    opportunityId: text('opportunity_id').notNull(),
    parentId: text('parent_id').references((): AnyPgColumn => commissionDeals.id, { onDelete: 'set null' }),
    merchantContact: text('merchant_contact').notNull().default(''),
    /** The merchant identity key — all deals group by this. */
    merchantEmail: text('merchant_email').notNull().default(''),
    merchantPhone: text('merchant_phone').notNull().default(''),
    creditLine: money('credit_line'),
    drawInitialPct: rate('draw_initial_pct'),
    /** LOC line fee (Revenued): % of the credit line paid at open, and the dollars it added to gross. */
    lineRate: rate('line_rate'),
    lineFee: money('line_fee').notNull().default(0),
    /** When the referral partner's fee for this deal was paid out; null = still owed. */
    referralPaidAt: isoDate('referral_paid_at'),
    /** The deal this one renewed or refinanced (renewal chain). */
    renewedFromId: text('renewed_from_id'),
    drawSubsequentPct: rate('draw_subsequent_pct'),
    psfPct: rate('psf_pct').notNull().default(0),
    originationFee: money('origination_fee').notNull().default(0),
    /** Dollars collected on the initial segment (non-scheduled lenders). */
    commCollected: money('comm_collected'),
    /** `{mode:'weekly', weeks, received, startDate}` for weekly lenders. */
    commSchedule: jsonb('comm_schedule').$type<WeeklySchedule>(),
    frequency: text('frequency').notNull().default('Daily'),
    apr: numeric('apr', { precision: 8, scale: 4, mode: 'number' }),
    /** Overrides the deal id in the CRM link. */
    crmId: text('crm_id'),
    /** Audited tombstone: operational reads exclude deleted deals while all accounting dimensions remain valid. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by').references(() => commissionReps.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('commission_deals_date_idx').on(t.date),
    index('commission_deals_merchant_email_idx').on(t.merchantEmail),
    index('commission_deals_opportunity_idx').on(t.opportunityId),
    index('commission_deals_opener_idx').on(t.openerId),
    index('commission_deals_closer_idx').on(t.closerId),
    index('commission_deals_override_idx').on(t.overrideId),
  ],
);

/** One row per draw on a multi-draw opportunity. The deal id does not change. */
export const commissionDealDraws = pgTable(
  'commission_deal_draws',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dealId: text('deal_id')
      .notNull()
      .references(() => commissionDeals.id, { onDelete: 'cascade' }),
    n: integer('n').notNull(),
    /** `D1`, `D2`, … */
    ref: text('ref').notNull(),
    date: isoDate('date').notNull(),
    amount: money('amount').notNull(),
    commRate: rate('comm_rate').notNull(),
    gross: money('gross').notNull(),
    referralFee: money('referral_fee').notNull().default(0),
    net: money('net').notNull(),
    /** Dollars collected (non-scheduled). Status is derived, never stored. */
    collected: money('collected'),
    schedule: jsonb('schedule').$type<WeeklySchedule>(),
    /** Optional funding terms on the draw itself; payback and payment are computed at write time. */
    termDays: integer('term_days'),
    factor: numeric('factor', { precision: 8, scale: 4, mode: 'number' }),
    payback: money('payback'),
    payment: money('payment'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('commission_deal_draws_deal_n_idx').on(t.dealId, t.n), uniqueIndex('commission_deal_draws_deal_ref_idx').on(t.dealId, t.ref)],
);

/* ------------------------------------------------------------------ */
/* Payroll, the ledger, clawbacks                                      */
/* ------------------------------------------------------------------ */

export const commissionPayrollRuns = pgTable('commission_payroll_runs', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  start: isoDate('start').notNull(),
  end: isoDate('end').notNull(),
  /** draft | approved | paid | archived */
  status: text('status').notNull().default('draft'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  /** QuickBooks: set once the run's entries have posted (Phase 9). */
  qbPostedAt: timestamp('qb_posted_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const commissionClawbacks = pgTable(
  'commission_clawbacks',
  {
    id: text('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => commissionDeals.id, { onDelete: 'cascade' }),
    date: isoDate('date').notNull(),
    /** Deal-level amount clawed back by the lender. */
    amount: money('amount').notNull(),
    reason: text('reason').notNull().default(''),
    /** open | recovered — derived from the ledger by `clawbackStatus`, written alongside. */
    status: text('status').notNull().default('open'),
    // Phase 1 addition
    /** Roll-up of every negative ledger row against this clawback. Must equal `clawbackRecovered(lines, id)`. */
    recovered: money('recovered').notNull().default(0),
    /** A forgiven clawback remains available to historical recovery rows, but is not operationally active. */
    forgivenAt: timestamp('forgiven_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('commission_clawbacks_deal_idx').on(t.dealId), index('commission_clawbacks_active_deal_idx').on(t.dealId).where(sql`${t.forgivenAt} is null`)],
);

/**
 * The payment ledger — the single source of truth for "paid".
 * `amount` is signed: positive rows are payouts (GROSS settled), negative
 * rows are clawback recoveries. "Paid" is never derived from deal status.
 */
export const commissionPayoutLines = pgTable(
  'commission_payout_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Idempotency key: `F12|Opener|D2` or `cbrec|<clawback>|<run>|<rep>`. */
    key: text('key').notNull(),
    dealId: text('deal_id')
      .notNull()
      .references(() => commissionDeals.id),
    /** `base` | `D1` | … ; null on recovery rows. */
    segmentKey: text('segment_key'),
    /** Opener | Closer | Override | Clawback recovery */
    role: text('role').notNull(),
    repId: text('rep_id')
      .notNull()
      .references(() => commissionReps.id),
    amount: money('amount').notNull(),
    runId: text('run_id').references(() => commissionPayrollRuns.id),
    clawbackId: text('clawback_id').references(() => commissionClawbacks.id),
    /** Date the payout cleared — the axis "paid" buckets on (invariant #7). */
    paidAt: isoDate('paid_at').notNull(),
    /** On a Void row: the key of the row it reverses. The ledger is append-only. */
    voids: text('voids'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('commission_payout_lines_key_idx').on(t.key),
    index('commission_payout_lines_rep_idx').on(t.repId),
    index('commission_payout_lines_run_idx').on(t.runId),
    index('commission_payout_lines_deal_idx').on(t.dealId),
    index('commission_payout_lines_clawback_idx').on(t.clawbackId),
  ],
);

/** Append-only deal-linked wallet corrections; never a payout or cash event. */
export const commissionWalletAdjustments = pgTable(
  'commission_wallet_adjustments',
  {
    id: text('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull(),
    dealId: text('deal_id').notNull().references(() => commissionDeals.id),
    repId: text('rep_id').notNull().references(() => commissionReps.id),
    amount: money('amount').notNull(),
    reason: text('reason').notNull(),
    effectiveDate: isoDate('effective_date').notNull(),
    actorRepId: text('actor_rep_id').notNull().references(() => commissionReps.id),
    reversalOf: text('reversal_of').references((): AnyPgColumn => commissionWalletAdjustments.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('commission_wallet_adjustments_idempotency_idx').on(t.idempotencyKey),
    uniqueIndex('commission_wallet_adjustments_reversal_idx').on(t.reversalOf).where(sql`${t.reversalOf} is not null`),
    index('commission_wallet_adjustments_deal_idx').on(t.dealId),
    index('commission_wallet_adjustments_rep_idx').on(t.repId),
  ],
);

/* ------------------------------------------------------------------ */
/* Settings and integrations                                           */
/* ------------------------------------------------------------------ */

export interface CommissionThresholds {
  clawbackWindowDays: number;
  paymentOverdueDays: number;
  renewalMark: number;
  additionalCapitalAfterDays: number;
}

export interface CommissionLists {
  frequencies: string[];
  commissionStatuses: string[];
  dealStatuses: string[];
}

/** Key/value settings. Seeded from the workbook's SETTINGS, PARTNERS and REPS tabs. */
export type CommissionSettingValue =
  | { key: 'lenders'; value: Lender[] }
  | { key: 'partners'; value: ReferralPartner[] }
  | { key: 'products'; value: ProductRule[] }
  | { key: 'thresholds'; value: CommissionThresholds }
  | { key: 'lists'; value: CommissionLists }
  | { key: 'crm'; value: { urlTemplate: string } }
  | { key: 'payroll'; value: { cycle: 'Weekly' | 'Twice monthly' | 'Monthly' | 'Per deal on lender payment' } };

export const commissionSettings = pgTable('commission_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().$type<CommissionSettingValue['value']>(),
  updatedAt: updatedAt(),
});

/** Google Sheets mirror state. Portal is master; the sheet is a mirror (Phase 8). */
export const commissionSheetsSync = pgTable('commission_sheets_sync', {
  id: text('id').primaryKey().default('default'),
  spreadsheetId: text('spreadsheet_id'),
  autoPush: boolean('auto_push').notNull().default(true),
  lastPushAt: timestamp('last_push_at', { withTimezone: true }),
  lastPullAt: timestamp('last_pull_at', { withTimezone: true }),
  /** Per-tab revision/hash for change detection. */
  tabHashes: jsonb('tab_hashes').notNull().$type<Record<string, string>>().default(sql`'{}'::jsonb`),
  updatedAt: updatedAt(),
});

/** Durable replay protection for machine-to-machine sheet mutations. */
export const commissionSheetsSyncOperations = pgTable('commission_sheets_sync_operations', {
  operation: text('operation').notNull(),
  key: text('key').notNull(),
  payloadHash: text('payload_hash').notNull(),
  state: text('state').notNull().default('processing'),
  status: integer('status'),
  response: jsonb('response'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('commission_sheets_sync_operations_key_idx').on(t.operation, t.key)]);

/** Audit trail. Phase 2 writes one row per request served under admin/manager View-as. */
export const commissionAuditLog = pgTable(
  'commission_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorRepId: text('actor_rep_id')
      .notNull()
      .references(() => commissionReps.id),
    /** e.g. `view-as`, `login`, `logout` */
    action: text('action').notNull(),
    targetRepId: text('target_rep_id').references(() => commissionReps.id),
    path: text('path'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    /** Client address the request came from (behind the proxy: X-Forwarded-For). */
    ip: text('ip'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('commission_audit_log_actor_idx').on(t.actorRepId), index('commission_audit_log_at_idx').on(t.at)],
);

/* ------------------------------------------------------------------ */
/* Launch additions: password resets, deal notes, deal files           */
/* ------------------------------------------------------------------ */

/** One-time "forgot password" tokens. Only the sha256 of the token is stored. */
export const commissionPasswordResets = pgTable(
  'commission_password_resets',
  {
    id: text('id').primaryKey(),
    repId: text('rep_id')
      .notNull()
      .references(() => commissionReps.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('commission_password_resets_token_idx').on(t.tokenHash), index('commission_password_resets_rep_idx').on(t.repId)],
);

/** Timestamped notes on a deal — a history, not one overwritten field. */
export const commissionDealNotes = pgTable(
  'commission_deal_notes',
  {
    id: text('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => commissionDeals.id, { onDelete: 'cascade' }),
    authorRepId: text('author_rep_id')
      .notNull()
      .references(() => commissionReps.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('commission_deal_notes_deal_idx').on(t.dealId)],
);

/** Contracts, funding confirmations and the like, stored inline (capped at a few MB each). */
export const commissionDealFiles = pgTable(
  'commission_deal_files',
  {
    id: text('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => commissionDeals.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    /** Base64 of the bytes. Simpler than bytea across drivers; files are small. */
    data: text('data').notNull(),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => commissionReps.id),
    createdAt: createdAt(),
  },
  (t) => [index('commission_deal_files_deal_idx').on(t.dealId)],
);

/** Files on a rep (W-9, agreements). Same shape as deal files. */
export const commissionRepFiles = pgTable(
  'commission_rep_files',
  {
    id: text('id').primaryKey(),
    repId: text('rep_id')
      .notNull()
      .references(() => commissionReps.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    data: text('data').notNull(),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => commissionReps.id),
    createdAt: createdAt(),
  },
  (t) => [index('commission_rep_files_rep_idx').on(t.repId)],
);

/** If/then automation rules (Settings › Playbooks). The rule body is JSON so new triggers need no migration. */
export const commissionPlaybooks = pgTable('commission_playbooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  rule: jsonb('rule').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One row per rule firing per deal, so a rule never nags twice inside its repeat window. */
export const commissionPlaybookFirings = pgTable(
  'commission_playbook_firings',
  {
    id: text('id').primaryKey(),
    playbookId: text('playbook_id')
      .notNull()
      .references(() => commissionPlaybooks.id, { onDelete: 'cascade' }),
    dealId: text('deal_id')
      .notNull()
      .references(() => commissionDeals.id, { onDelete: 'cascade' }),
    repId: text('rep_id').references(() => commissionReps.id, { onDelete: 'set null' }),
    firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb('detail'),
  },
  (t) => [index('commission_playbook_firings_deal_idx').on(t.dealId, t.playbookId)],
);

/** A rep's to-do on a deal: opened by a playbook or by hand, closed with an outcome. */
export const commissionTasks = pgTable(
  'commission_tasks',
  {
    id: text('id').primaryKey(),
    dealId: text('deal_id')
      .notNull()
      .references(() => commissionDeals.id, { onDelete: 'cascade' }),
    repId: text('rep_id')
      .notNull()
      .references(() => commissionReps.id, { onDelete: 'cascade' }),
    playbookId: text('playbook_id').references(() => commissionPlaybooks.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    dueDate: isoDate('due_date').notNull(),
    status: text('status').notNull().default('open'),
    /** called | no_answer | app_submitted | funded | declined | not_interested */
    outcome: text('outcome'),
    note: text('note'),
    createdBy: text('created_by').references(() => commissionReps.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => [index('commission_tasks_rep_idx').on(t.repId, t.status), index('commission_tasks_deal_idx').on(t.dealId)],
);

/** "Remember this device" after a two-factor sign-in: the browser holds a secret, this row holds its hash. */
export const commissionTrustedDevices = pgTable(
  'commission_trusted_devices',
  {
    id: text('id').primaryKey(),
    repId: text('rep_id')
      .notNull()
      .references(() => commissionReps.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** Browser / OS summary from the user agent, for the "your devices" list. */
    label: text('label').notNull().default(''),
    ip: text('ip'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('commission_trusted_devices_rep_idx').on(t.repId), uniqueIndex('commission_trusted_devices_hash_idx').on(t.tokenHash)],
);

/* ------------------------------------------------------------------ */
/* Double-entry books (append-only source journals)                    */
/* ------------------------------------------------------------------ */
export const commissionAccounts = pgTable('commission_accounts', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  /** Fixed system-purpose accounts are protected by the database trigger. */
  purpose: text('purpose').notNull().unique(),
  system: boolean('system').notNull().default(true),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const commissionAccountingPeriods = pgTable('commission_accounting_periods', {
  id: uuid('id').primaryKey().defaultRandom(),
  start: isoDate('start').notNull(),
  end: isoDate('end').notNull(),
  status: text('status').notNull().default('open'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by').references(() => commissionReps.id),
  reopenedAt: timestamp('reopened_at', { withTimezone: true }),
  reopenedBy: text('reopened_by').references(() => commissionReps.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('commission_accounting_period_range_idx').on(t.start, t.end)]);

export const commissionJournals = pgTable('commission_journals', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceKey: text('source_key').notNull(),
  sourceType: text('source_type').notNull(),
  date: isoDate('date').notNull(),
  memo: text('memo').notNull(),
  fingerprint: text('fingerprint').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  reversalOf: uuid('reversal_of'),
  logicalSourceKey: text('logical_source_key').notNull(),
  sourceVersion: integer('source_version').notNull().default(1),
  correctionDate: isoDate('correction_date'),
  detectedAt: timestamp('detected_at', { withTimezone: true }),
  postingStatus: text('posting_status').notNull().default('sealed'),
  sealedAt: timestamp('sealed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('commission_journals_source_key_idx').on(t.sourceKey),
  uniqueIndex('commission_journals_logical_version_kind_idx').on(t.logicalSourceKey, t.sourceVersion, t.sourceType),
  index('commission_journals_date_idx').on(t.date),
]);

export const commissionJournalLines = pgTable('commission_journal_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  journalId: uuid('journal_id').notNull().references(() => commissionJournals.id, { onDelete: 'restrict' }),
  accountCode: text('account_code').notNull().references(() => commissionAccounts.code, { onDelete: 'restrict' }),
  debit: money('debit').notNull().default(0),
  credit: money('credit').notNull().default(0),
  memo: text('memo'),
  dealId: text('deal_id').references(() => commissionDeals.id, { onDelete: 'restrict' }),
  repId: text('rep_id').references(() => commissionReps.id, { onDelete: 'restrict' }),
  createdAt: createdAt(),
}, (t) => [index('commission_journal_lines_journal_idx').on(t.journalId), index('commission_journal_lines_account_idx').on(t.accountCode)]);

/** Mutable concurrency pointer only; every journal in the chain remains immutable. */
export const commissionAccountingSourceChains = pgTable('commission_accounting_source_chains', {
  logicalSourceKey: text('logical_source_key').primaryKey(),
  sourceVersion: integer('source_version').notNull().default(1),
  effectiveJournalId: uuid('effective_journal_id').references(() => commissionJournals.id, { onDelete: 'restrict' }),
  currentFingerprint: text('current_fingerprint'),
  updatedAt: updatedAt(),
});

export const commissionReconciliations = pgTable('commission_reconciliations', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountCode: text('account_code').notNull().references(() => commissionAccounts.code),
  statementStart: isoDate('statement_start').notNull(),
  statementDate: isoDate('statement_date').notNull(),
  openingBalance: money('opening_balance').notNull(),
  statementBalance: money('statement_balance').notNull(),
  status: text('status').notNull().default('open'),
  note: text('note'),
  createdBy: text('created_by').references(() => commissionReps.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const commissionReconciliationMatches = pgTable('commission_reconciliation_matches', {
  id: uuid('id').primaryKey().defaultRandom(),
  reconciliationId: uuid('reconciliation_id').notNull().references(() => commissionReconciliations.id, { onDelete: 'cascade' }),
  journalLineId: uuid('journal_line_id').notNull().references(() => commissionJournalLines.id, { onDelete: 'restrict' }),
  amount: money('amount').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('commission_reconciliation_match_unique_idx').on(t.reconciliationId, t.journalLineId)]);

/* ------------------------------------------------------------------ */
/* Relations                                                           */
/* ------------------------------------------------------------------ */

export const commissionRepsRelations = relations(commissionReps, ({ one, many }) => ({
  team: one(commissionTeams, { fields: [commissionReps.teamId], references: [commissionTeams.id] }),
  payoutLines: many(commissionPayoutLines),
}));

export const commissionTeamsRelations = relations(commissionTeams, ({ one, many }) => ({
  leader: one(commissionReps, { fields: [commissionTeams.leaderRepId], references: [commissionReps.id] }),
  reps: many(commissionReps),
}));

export const commissionDealsRelations = relations(commissionDeals, ({ one, many }) => ({
  draws: many(commissionDealDraws),
  clawbacks: many(commissionClawbacks),
  payoutLines: many(commissionPayoutLines),
  opener: one(commissionReps, { fields: [commissionDeals.openerId], references: [commissionReps.id], relationName: 'opener' }),
  closer: one(commissionReps, { fields: [commissionDeals.closerId], references: [commissionReps.id], relationName: 'closer' }),
  override: one(commissionReps, { fields: [commissionDeals.overrideId], references: [commissionReps.id], relationName: 'override' }),
  parent: one(commissionDeals, { fields: [commissionDeals.parentId], references: [commissionDeals.id], relationName: 'parent' }),
}));

export const commissionDealDrawsRelations = relations(commissionDealDraws, ({ one }) => ({
  deal: one(commissionDeals, { fields: [commissionDealDraws.dealId], references: [commissionDeals.id] }),
}));

export const commissionClawbacksRelations = relations(commissionClawbacks, ({ one, many }) => ({
  deal: one(commissionDeals, { fields: [commissionClawbacks.dealId], references: [commissionDeals.id] }),
  recoveries: many(commissionPayoutLines),
}));

export const commissionPayoutLinesRelations = relations(commissionPayoutLines, ({ one }) => ({
  deal: one(commissionDeals, { fields: [commissionPayoutLines.dealId], references: [commissionDeals.id] }),
  rep: one(commissionReps, { fields: [commissionPayoutLines.repId], references: [commissionReps.id] }),
  run: one(commissionPayrollRuns, { fields: [commissionPayoutLines.runId], references: [commissionPayrollRuns.id] }),
  clawback: one(commissionClawbacks, { fields: [commissionPayoutLines.clawbackId], references: [commissionClawbacks.id] }),
}));
export const commissionWalletAdjustmentsRelations = relations(commissionWalletAdjustments, ({ one }) => ({
  deal: one(commissionDeals, { fields: [commissionWalletAdjustments.dealId], references: [commissionDeals.id] }),
  rep: one(commissionReps, { fields: [commissionWalletAdjustments.repId], references: [commissionReps.id] }),
  actor: one(commissionReps, { fields: [commissionWalletAdjustments.actorRepId], references: [commissionReps.id], relationName: 'adjustmentActor' }),
}));

export const commissionPayrollRunsRelations = relations(commissionPayrollRuns, ({ many }) => ({
  payoutLines: many(commissionPayoutLines),
}));

/* Row types */
export type RepRow = typeof commissionReps.$inferSelect;
export type TeamRow = typeof commissionTeams.$inferSelect;
export type DealRow = typeof commissionDeals.$inferSelect;
export type DealDrawRow = typeof commissionDealDraws.$inferSelect;
export type PayoutLineRow = typeof commissionPayoutLines.$inferSelect;
export type WalletAdjustmentRow = typeof commissionWalletAdjustments.$inferSelect;
export type ClawbackRow = typeof commissionClawbacks.$inferSelect;
export type PayrollRunRow = typeof commissionPayrollRuns.$inferSelect;
export type SettingRow = typeof commissionSettings.$inferSelect;
export type AuditLogRow = typeof commissionAuditLog.$inferSelect;
export type PasswordResetRow = typeof commissionPasswordResets.$inferSelect;
export type DealNoteRow = typeof commissionDealNotes.$inferSelect;
export type DealFileRow = typeof commissionDealFiles.$inferSelect;
