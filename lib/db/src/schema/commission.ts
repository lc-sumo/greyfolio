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
  /** draft | approved | paid */
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
    createdAt: createdAt(),
  },
  (t) => [index('commission_clawbacks_deal_idx').on(t.dealId)],
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

export const commissionPayrollRunsRelations = relations(commissionPayrollRuns, ({ many }) => ({
  payoutLines: many(commissionPayoutLines),
}));

/* Row types */
export type RepRow = typeof commissionReps.$inferSelect;
export type TeamRow = typeof commissionTeams.$inferSelect;
export type DealRow = typeof commissionDeals.$inferSelect;
export type DealDrawRow = typeof commissionDealDraws.$inferSelect;
export type PayoutLineRow = typeof commissionPayoutLines.$inferSelect;
export type ClawbackRow = typeof commissionClawbacks.$inferSelect;
export type PayrollRunRow = typeof commissionPayrollRuns.$inferSelect;
export type SettingRow = typeof commissionSettings.$inferSelect;
