/**
 * Domain types for the Greystone commission portal.
 *
 * Dates are ISO calendar strings (`YYYY-MM-DD`) so the domain layer is
 * timezone-free; the API converts at the edge.
 */

export type Role = 'Opener' | 'Closer' | 'Override';
export const ROLES: readonly Role[] = ['Opener', 'Closer', 'Override'];

/** Ledger rows carry a role, or the recovery marker. */
export type LedgerRole = Role | 'Clawback recovery';

/** `base` is the initial funding; `D1`, `D2`, … are draws. */
export type SegmentKey = 'base' | `D${number}`;

export type CommissionBasis = 'funded' | 'draw' | 'payback';

export type CommissionStatus =
  | 'Waiting for payment'
  | 'Invoice Sent'
  | 'Partially Paid'
  | 'YES - Paid In Full';

export type LenderTerms = 'upfront' | 'weekly';

export interface Lender {
  name: string;
  terms: LenderTerms;
  /** Number of increments when `terms === 'weekly'`; 0 otherwise. */
  weeks: number;
  /** Default payout structure for this lender's incremental deals (overridable per deal). */
  upfrontPct?: number;
  remainder?: 'spread' | 'at-end';
  cadenceDays?: number;
  /**
   * Product names this lender funds. Increments only ever apply when one of
   * them is an incremental (consolidation) product; empty/absent = any product.
   */
  products?: string[];
  /** Lender clawback policy. Absent = the global clawback-window default. */
  clawback?: LenderClawbackPolicy;
}

export type ClawbackBasis = 'none' | 'days' | 'payments';
export interface LenderClawbackPolicy {
  /** 'none' = this lender never claws back; 'days' after funding; 'payments' the merchant has made. */
  basis: ClawbackBasis;
  count: number;
  note?: string;
}

export interface ReferralPartner {
  name: string;
  /** Fraction of gross. */
  pct: number;
  /** Monthly cap in dollars; `null` = uncapped (workbook: blank cap). */
  monthlyCap: number | null;
}

export interface ProductRule {
  name: string;
  basis: CommissionBasis;
  /** Product carries a factor rate (else APR). */
  factor: boolean;
  /** Product carries a term in business days. */
  term: boolean;
  /** Product must attach to a parent opportunity. */
  parent: boolean;
  /** Default commission rate (fraction). */
  comm: number;
  clawback: boolean;
  renewal: boolean;
  multiDraw: boolean;
  drawInitial: number | null;
  drawSubsequent: number | null;
  /**
   * Commission arrives from the lender in increments (consolidations). Only
   * incremental products get a payout schedule; LOCs and their draws are paid
   * upfront and never ask for one.
   */
  incremental?: boolean;
}

/**
 * Incremental commission from the lender (consolidations, some LOCs).
 *
 *   upfrontPct  share of gross paid at funding (0 = none, 0.5 = "50 upfront")
 *   weeks       number of increments the lender pays after the upfront
 *   cadenceDays days between increments (7 = weekly, 14, 30)
 *   remainder   'spread' → the non-upfront share is split evenly across the increments
 *               'at-end' → the non-upfront share is paid once, when the increments are done
 *   received    increments that have landed (for 'at-end' this tracks the merchant's progress)
 *   startDate   when the first increment is expected
 */
export interface WeeklySchedule {
  mode: 'weekly';
  weeks: number;
  received: number;
  startDate: string | null;
  cadenceDays?: number;
  upfrontPct?: number;
  upfrontReceived?: boolean;
  remainder?: 'spread' | 'at-end';
  remainderReceived?: boolean;
  /**
   * A consolidation is FUNDED in increments too: each lender increment is a
   * disbursement to the merchant. When the merchant opts out part-way, the
   * increment they stopped after is recorded here and every planned figure
   * (funded, gross, referral, net, rep shares) scales down to what was disbursed.
   */
  stoppedAfter?: number | null;
}

export type CommissionSchedule = WeeklySchedule;

export interface Rep {
  id: string;
  name: string;
  email: string;
  role: 'rep' | 'manager' | 'admin';
  teamId: string | null;
  openerRate: number;
  closerRate: number;
  /** `null` = fall back to the team's override rate. */
  overrideRate: number | null;
  active: boolean;
}

export interface Team {
  id: string;
  name: string;
  leaderRepId: string | null;
  overrideRate: number;
}

export interface DealDraw {
  n: number;
  /** `D1`, `D2`, … */
  ref: SegmentKey;
  date: string;
  amount: number;
  commRate: number;
  gross: number;
  referralFee: number;
  net: number;
  /** Dollars received from the lender (non-scheduled draws). */
  collected: number | null;
  schedule: WeeklySchedule | null;
  /** Optional funding terms on the draw itself (a draw may carry its own term and factor). */
  termDays?: number | null;
  factor?: number | null;
  /** amount × factor when a factor is given. */
  payback?: number | null;
  /** The merchant's payment per `frequency` period over the term. */
  payment?: number | null;
}

export interface Deal {
  /** `F1`, `F2`, … — the sheet's series. */
  id: string;
  /** Groups multi-funding facilities; defaults to own id. */
  opportunityId: string;
  parentId: string | null;
  /** Funded date, `YYYY-MM-DD`. Never in the future. */
  date: string;
  business: string;
  merchantContact: string;
  /** Merchant identity key. */
  merchantEmail: string;
  merchantPhone: string;
  lender: string;
  product: string;
  funded: number;
  factor: number | null;
  apr: number | null;
  termDays: number | null;
  frequency: string;
  payback: number | null;
  commRate: number;
  psfPct: number;
  originationFee: number;
  referralPartner: string | null;
  referralRate: number;
  gross: number;
  referralFee: number;
  net: number;
  openerId: string | null;
  openerRate: number;
  closerId: string | null;
  closerRate: number;
  overrideId: string | null;
  overrideRate: number;
  /** Dollars collected on the initial segment (non-scheduled). */
  commCollected: number | null;
  commSchedule: WeeklySchedule | null;
  creditLine: number | null;
  drawInitialPct: number | null;
  drawSubsequentPct: number | null;
  dealStatus: string;
  /** Stamped when every role line on every segment is in the ledger. */
  repPaid: string | null;
  lenderPaid: string | null;
  crmId: string | null;
  draws: DealDraw[];
}

/** One commissionable event on an opportunity. */
export interface Segment {
  dealId: string;
  sk: SegmentKey;
  label: string;
  n: number;
  date: string;
  amount: number;
  commRate: number;
  gross: number;
  referralFee: number;
  net: number;
  collected: number | null;
  schedule: WeeklySchedule | null;
  /** Set when the merchant opted out of an incremental plan: the figures as entered, before scaling to what was disbursed. */
  planned?: { amount: number; gross: number; referralFee: number; net: number; increments: number } | null;
}

/**
 * The payment ledger — the ONLY source of truth for "paid".
 * `amount` is signed: positive for payouts, negative for clawback recoveries.
 */
export interface PayoutLine {
  /** Idempotency key: `F12|Opener|D2` or `cbrec|cb-3|run-4|rep-07`. */
  key: string;
  dealId: string;
  segmentKey: SegmentKey | null;
  role: LedgerRole;
  repId: string;
  amount: number;
  runId: string | null;
  clawbackId: string | null;
  /** Date the payout cleared, `YYYY-MM-DD`. */
  paidAt: string;
}

export interface Clawback {
  id: string;
  dealId: string;
  date: string;
  /** Deal-level amount clawed back by the lender. */
  amount: number;
  /** Roll-up of every negative ledger row against this clawback. */
  recovered: number;
  reason: string;
  status: 'open' | 'recovered';
}

export interface PayrollRun {
  id: string;
  label: string;
  start: string;
  end: string;
  status: 'draft' | 'approved' | 'paid';
}

/** Everything the ledger needs. Loaded once per request, then pure. */
export interface LedgerContext {
  deals: Deal[];
  lines: PayoutLine[];
  clawbacks: Clawback[];
}
