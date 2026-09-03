/**
 * Seed data lifted from `GREYSTONE TRACKER - CLEAN TEMPLATE.xlsx`
 * (design_handoff_greystone_commission_portal/). Values are copied verbatim
 * from the `REPS`, `SETTINGS` and `PARTNERS` tabs; anything the workbook does
 * not carry (lender terms, product rules, rep emails, teams) is marked
 * `// assumption` and listed in docs/PHASE-1-REVIEW.md for confirmation.
 */
import type { Lender, ProductRule, Rep, ReferralPartner } from '@greystone/commission';
import type { CommissionLists, CommissionThresholds } from '../schema/commission.js';

/* ------------------------------------------------------------------ */
/* REPS tab — columns A:D and J (Rep Name, Opener %, Closer %, Override %, Active) */
/* ------------------------------------------------------------------ */

export interface WorkbookRep {
  name: string;
  openerRate: number;
  closerRate: number;
  /** Blank in the workbook → null (falls back to the team override rate). */
  overrideRate: number | null;
  active: boolean;
}

export const WORKBOOK_REPS: readonly WorkbookRep[] = [
  { name: 'Leor', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { name: 'Raymond Amato', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { name: 'Azi Sharbani', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { name: 'Nick Faldo', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { name: 'Zach Sanders', openerRate: 0.4, closerRate: 0.4, overrideRate: 0.05, active: true },
  { name: 'Gil Dichy', openerRate: 0.3, closerRate: 0.3, overrideRate: 0.05, active: true },
  { name: 'Julian Ribak', openerRate: 0.35, closerRate: 0.35, overrideRate: 0.025, active: true },
  { name: 'Louie Palleta', openerRate: 0.35, closerRate: 0.35, overrideRate: 0.05, active: true },
  { name: 'Jacobo Simkin', openerRate: 0.35, closerRate: 0.35, overrideRate: 0.05, active: true },
  { name: 'Gabriel Barnes', openerRate: 0.3, closerRate: 0.3, overrideRate: 0.05, active: true },
  { name: 'Edward Obi', openerRate: 0.15, closerRate: 0.15, overrideRate: 0.05, active: true },
  { name: 'Shulamit Cohen', openerRate: 0.3, closerRate: 0.3, overrideRate: 0.05, active: true },
  { name: 'Albert Dichy', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.075, active: true },
  { name: 'Louie Espinoza', openerRate: 0.35, closerRate: 0.35, overrideRate: 0.05, active: true },
  { name: 'Noah Levine', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { name: 'Samuel Knox', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { name: 'Rav Sova', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { name: 'Netanel Benjamin', openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05, active: true },
  { name: 'Solomon Gold', openerRate: 0.2, closerRate: 0.15, overrideRate: null, active: true },
  { name: 'Mark Gold', openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: true },
  { name: 'Aaron Dahan', openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: true },
  { name: 'Darren Wolf', openerRate: 0.2, closerRate: 0.15, overrideRate: null, active: true },
  { name: 'David Silvers', openerRate: 0.2, closerRate: 0.15, overrideRate: null, active: true },
  { name: 'Jason Reed', openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: true },
  { name: 'Levi Forgash', openerRate: 0.2, closerRate: 0.2, overrideRate: null, active: true },
];

/** Workbook defaults: 20% opener / 20% closer / 5% override. */
export const DEFAULT_RATES = { openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05 } as const;

export function repId(name: string): string {
  return `rep-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
}

/** assumption: `first.last@greystoneus.com` — the workbook has no emails. Confirm before OIDC links on it. */
export function repEmail(name: string): string {
  const parts = name.toLowerCase().split(/\s+/).filter(Boolean);
  return `${parts.join('.')}@greystoneus.com`;
}

/** The REPS tab as domain reps. Only Leor is an admin; team leads are open question #4. */
export function seedReps(): Rep[] {
  return WORKBOOK_REPS.map((r) => ({
    id: repId(r.name),
    name: r.name,
    email: repEmail(r.name),
    role: r.name === 'Leor' ? 'admin' : 'rep', // assumption
    teamId: null, // teams do not exist in the workbook (open question #4)
    openerRate: r.openerRate,
    closerRate: r.closerRate,
    overrideRate: r.overrideRate,
    active: r.active,
  }));
}

/* ------------------------------------------------------------------ */
/* SETTINGS tab                                                        */
/* ------------------------------------------------------------------ */

export const COMPANY_NAME = 'GREYSTONE';

/** SETTINGS!C — payment frequency dropdown. */
export const FREQUENCIES = ['Daily', 'Weekly', 'Bi-Weekly', 'Monthly'] as const;

/**
 * SETTINGS!D — the sheet's commission-status dropdown. The portal derives the
 * first four from collection (`statusFor`); `Clawed Back` and
 * `NO - Never got paid` are sheet-only markers kept for the mirror.
 */
export const COMMISSION_STATUSES = [
  'Waiting for payment',
  'Invoice Sent',
  'Partially Paid',
  'YES - Paid In Full',
  'Clawed Back',
  'NO - Never got paid',
] as const;

/** SETTINGS!F — deal status dropdown. */
export const DEAL_STATUSES = ['Performing', 'Prospecting', 'Refi Ready', 'Refinanced', 'Default', 'Paid In Full'] as const;

/**
 * SETTINGS!E — lenders. Commission terms are not in the workbook; the weekly
 * lenders and their week counts come from the prototype. // assumption
 */
// assumption: which products each lender funds and its clawback policy are not
// in the workbook; these are editable in Settings › Lenders and listed for confirmation.
const CONSOL = ['CONSOLIDATION - UPFRONT COMM', 'CONSOLIDATION DISBURSEMENT'];
const REVERSE = ['REVERSE - TOTAL FUNDING', 'REVERSE - DISBURSEMENT'];
const LOC = ['LOC - INITIAL', 'LOC DRAW'];
export const LENDERS: readonly Lender[] = [
  { name: 'MBC', terms: 'upfront', weeks: 0, products: ['MCA', 'TERM LOAN', 'SBA'], clawback: { basis: 'days', count: 30 } },
  { name: 'ACE FUNDING', terms: 'upfront', weeks: 0, products: ['MCA', 'EQUIPMENT'], clawback: { basis: 'days', count: 45 } },
  { name: 'ROWAN', terms: 'weekly', weeks: 20, products: [...CONSOL, 'MCA'], clawback: { basis: 'payments', count: 10 } },
  { name: 'ENOD CAPITAL', terms: 'weekly', weeks: 12, products: [...CONSOL, ...REVERSE], clawback: { basis: 'payments', count: 15 } },
  { name: 'IDEA', terms: 'upfront', weeks: 0, products: [...REVERSE, 'REAL ESTATE'], clawback: { basis: 'days', count: 30 } },
  { name: 'BIZPOINT', terms: 'upfront', weeks: 0, products: [...LOC, 'MCA'], clawback: { basis: 'days', count: 30 } },
  { name: 'Lendini', terms: 'weekly', weeks: 16, products: [...CONSOL], clawback: { basis: 'payments', count: 20 } },
  { name: 'WALL', terms: 'upfront', weeks: 0, products: ['EQUIPMENT', 'REAL ESTATE', 'TERM LOAN'], clawback: { basis: 'none', count: 0 } },
  { name: 'UFS FUNDING', terms: 'upfront', weeks: 0, products: [...LOC, 'SBA', 'TERM LOAN'], clawback: { basis: 'days', count: 60 } },
  { name: 'MILVADO CAPITAL', terms: 'upfront', weeks: 0, products: ['MCA', ...REVERSE], clawback: { basis: 'days', count: 30 } }, // assumption: terms unknown
  { name: 'Cetan Funds', terms: 'upfront', weeks: 0, products: ['MCA', 'EQUIPMENT'], clawback: { basis: 'days', count: 30 } }, // assumption: terms unknown
];

/**
 * SETTINGS!B — products. Rules (basis, default %, flags) are not in the
 * workbook; they come from the prototype where it defined them, and the three
 * disbursement/draw products get `basis:'draw'` + `parent:true` because the
 * sheet's `Parent Deal` formula names their parents. // assumption
 */
export const PRODUCTS: readonly ProductRule[] = [
  { name: 'MCA', basis: 'funded', factor: true, term: true, parent: false, comm: 0.12, clawback: true, renewal: true, multiDraw: false, drawInitial: null, drawSubsequent: null },
  { name: 'LOC - INITIAL', basis: 'funded', factor: false, term: true, parent: false, comm: 0.08, clawback: true, renewal: false, multiDraw: true, drawInitial: 0.08, drawSubsequent: 0.04 },
  { name: 'LOC DRAW', basis: 'draw', factor: false, term: false, parent: true, comm: 0.04, clawback: true, renewal: false, multiDraw: false, drawInitial: null, drawSubsequent: null },
  { name: 'CONSOLIDATION - UPFRONT COMM', basis: 'funded', factor: true, term: true, parent: false, comm: 0.1, clawback: true, renewal: true, multiDraw: true, drawInitial: 0.1, drawSubsequent: 0.05, incremental: true },
  { name: 'CONSOLIDATION DISBURSEMENT', basis: 'draw', factor: false, term: false, parent: true, comm: 0.05, clawback: true, renewal: false, multiDraw: false, drawInitial: null, drawSubsequent: null, incremental: true },
  { name: 'REVERSE - TOTAL FUNDING', basis: 'payback', factor: true, term: true, parent: false, comm: 0.06, clawback: true, renewal: true, multiDraw: true, drawInitial: 0.06, drawSubsequent: 0.06 },
  { name: 'REVERSE - DISBURSEMENT', basis: 'draw', factor: false, term: false, parent: true, comm: 0.06, clawback: true, renewal: false, multiDraw: false, drawInitial: null, drawSubsequent: null },
  { name: 'TERM LOAN', basis: 'funded', factor: false, term: true, parent: false, comm: 0.05, clawback: false, renewal: true, multiDraw: false, drawInitial: null, drawSubsequent: null },
  { name: 'EQUIPMENT', basis: 'funded', factor: false, term: true, parent: false, comm: 0.06, clawback: false, renewal: false, multiDraw: false, drawInitial: null, drawSubsequent: null },
  { name: 'REAL ESTATE', basis: 'funded', factor: false, term: true, parent: false, comm: 0.02, clawback: false, renewal: false, multiDraw: false, drawInitial: null, drawSubsequent: null },
  { name: 'SBA', basis: 'funded', factor: false, term: true, parent: false, comm: 0.03, clawback: false, renewal: false, multiDraw: false, drawInitial: null, drawSubsequent: null },
];

/** SETTINGS!I — thresholds. */
export const THRESHOLDS: CommissionThresholds = {
  clawbackWindowDays: 30,
  paymentOverdueDays: 14,
  renewalMark: 0.4,
  additionalCapitalAfterDays: 30,
};

export const LISTS: CommissionLists = {
  frequencies: [...FREQUENCIES],
  commissionStatuses: [...COMMISSION_STATUSES],
  dealStatuses: [...DEAL_STATUSES],
};

/** Blank template hides every CRM link until the real pattern is known (open question #6). */
export const CRM_URL_TEMPLATE = '';

/* ------------------------------------------------------------------ */
/* PARTNERS tab — Referral Partner, Referral %, Monthly Cap $          */
/* ------------------------------------------------------------------ */

/**
 * Verbatim from the sheet, including the oddity that `NONE` carries 10% and
 * `None` carries 0%. Blank cap = uncapped (sheet note: "Blank cap on a partner = uncapped.").
 */
export const PARTNERS: readonly ReferralPartner[] = [
  { name: 'MBC', pct: 0.15, monthlyCap: 15_000 },
  { name: 'NONE', pct: 0.1, monthlyCap: null },
  { name: 'HUB TRACKER', pct: 0.1, monthlyCap: null },
  { name: 'None', pct: 0, monthlyCap: null },
];

/** Every settings row the seed writes. */
export function seedSettings(): Array<{ key: string; value: unknown }> {
  return [
    { key: 'lenders', value: LENDERS },
    { key: 'partners', value: PARTNERS },
    { key: 'products', value: PRODUCTS },
    { key: 'thresholds', value: THRESHOLDS },
    { key: 'lists', value: LISTS },
    { key: 'crm', value: { urlTemplate: CRM_URL_TEMPLATE } },
    { key: 'payroll', value: { cycle: 'Twice monthly' } },
  ];
}
