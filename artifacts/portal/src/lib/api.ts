import type { PlaybookRule as PlaybookRuleT } from '../../../api-server/src/services/playbook-rules';
/* Types mirror artifacts/api-server/src/scope.ts. */
export type Role = 'Opener' | 'Closer' | 'Override';
export type CommissionStatus = 'Waiting for payment' | 'Invoice Sent' | 'Partially Paid' | 'YES - Paid In Full';
export type PayoutStatus = 'Paid' | 'Partially paid' | 'Owed' | 'Awaiting lender';

export interface SessionUser { repId: string; email: string; name: string; role: 'rep' | 'manager' | 'admin' }
export interface Branding { company: string; portal: string; supportEmail: string }
export interface AuthMe { user: SessionUser; canViewAs: boolean; oidc: boolean; devAuth: boolean; branding?: Branding; mustEnrollTotp?: boolean }
export interface RepRoleLine { role: Role; rate: number; amount: number; segment: string; segmentKey: string; paid: boolean; paidAmount: number; units: { paid: number; total: number; collected: number } | null }
export interface RepDealView {
  id: string; crmId: string | null; date: string; business: string; merchantContact: string; merchantEmail: string; merchantPhone: string; lender: string; product: string; funded: number; drawCount: number;
  disbursement: Disbursement | null;
  roles: Role[]; lines: RepRoleLine[]; share: number; accrued: number; paid: number; owed: number; payoutStatus: PayoutStatus;
  commissionStatus: CommissionStatus; lenderPaidLabel: string; dealStatus: string; repPaid: string | null; clawbackWindow: ClawbackWindow;
  clawback: { amount: number; remaining: number; status: 'open' | 'recovered' } | null;
}
export interface RepDealDetail extends RepDealView { payments: Array<{ role: string; segmentKey: string | null; unit: string | null; amount: number; paidAt: string; runId: string | null }> }
export interface RepWallet { earned: number; paid: number; cash: number; held: number; recovered: number; owed: number; dealCount: number; awaitingLender: number }
export interface LeaderboardRow { rank: number; label: string; isMe: boolean; commission: number | null }
export interface RepDashboard {
  wallet: RepWallet;
  nextPayout: { date: string | null; runLabel: string | null; cycle: string };
  period: { from: string; to: string; earned: number; paid: number; recovered: number; owed: number; funded: number; dealCount: number; rank: number | null; repCount: number };
  monthly: Array<{ month: string; earned: number; paid: number }>;
  leaderboard: LeaderboardRow[];
  owedToMe: RepDealView[];
}
export interface RepClawbackView { id: string; dealId: string; date: string; business: string; dealClawback: number; chargedToMe: number; recovered: number; remaining: number; reason: string; status: 'open' | 'recovered' }
export interface RepStatement { runId: string; period: string; status: 'draft' | 'approved' | 'paid'; dealCount: number; grossPaid: number; clawbacks: number; netPaid: number }
export interface MeInfo { rep: { id: string; name: string; email: string; role: string; active: boolean }; viewAs: boolean; actor: { id: string; name: string; role: string } | null }
export interface RosterRep { id: string; name: string; email: string; role: string; teamId: string | null; team: string | null; openerRate: number; closerRate: number; overrideRate: number | null; active: boolean; hasPassword?: boolean; hasTotp?: boolean; earned: number; paid: number; held: number; owed: number; dealCount: number }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let viewAs: string | null = null;
export function setViewAs(id: string | null) { viewAs = id; }
export function getViewAs() { return viewAs; }

/** Demo build: the API runs in the browser over the demo board (see demo-api.ts). */
export const DEMO = import.meta.env.VITE_DEMO === '1';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (DEMO) {
    const { demoFetch } = await import('./demo-api');
    return demoFetch<T>(path, init, viewAs);
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string>) };
  if (viewAs) headers['X-View-As'] = viewAs;
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (body && body.error) || res.statusText);
  return body as T;
}

export const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/* ---- Admin (Phase 4). Never served to reps. ---- */
export type ClawbackBasis = 'none' | 'days' | 'payments';
export interface LenderClawbackPolicy { basis: ClawbackBasis; count: number; note?: string }
export interface Lender { name: string; terms: 'upfront' | 'weekly'; weeks: number; upfrontPct?: number; remainder?: 'spread' | 'at-end'; cadenceDays?: number; products?: string[]; clawback?: LenderClawbackPolicy; locLineRate?: number; paymentTermsDays?: number; active?: boolean; renamedFrom?: string }
export interface ClawbackWindow { basis: ClawbackBasis; count: number; source: 'lender' | 'product' | 'default'; clearsOn: string | null; cleared: boolean; daysLeft: number | null; label: string }
export interface ReferralPartner { name: string; pct: number; monthlyCap: number | null; active?: boolean; renamedFrom?: string }
export interface ProductRule { name: string; basis: 'funded' | 'draw' | 'payback'; factor: boolean; term: boolean; parent: boolean; comm: number; clawback: boolean; renewal: boolean; multiDraw: boolean; drawInitial: number | null; drawSubsequent: number | null; incremental?: boolean; active?: boolean; renamedFrom?: string }
export interface Settings {
  lenders: Lender[]; partners: ReferralPartner[]; products: ProductRule[];
  thresholds: { clawbackWindowDays: number; paymentOverdueDays: number; renewalMark: number; additionalCapitalAfterDays: number };
  lists: { frequencies: string[]; commissionStatuses: string[]; dealStatuses: string[] };
  crm: { urlTemplate: string }; payroll: { cycle: string };
  portal: Branding;
  notifications: { statements: boolean; clawbacks: boolean; renewalDigest: boolean; digestHourUtc: number; repQuestions: boolean; playbookHourUtc: number };
  security: { requireTotpForAdmins: boolean };
  templates: { merchant: MerchantTemplate[] };
}
export interface MerchantTemplate { id: string; name: string; subject: string; body: string }
export interface RoleView { role: Role; repId: string | null; name: string | null; rate: number; amount: number; paid: number }
export interface AdminDealRow {
  id: string; renewedFromId: string | null; renewedById: string | null; opportunityId: string; parentId: string | null; date: string; business: string; drawCount: number;
  merchantContact: string; merchantEmail: string; merchantPhone: string; lender: string; product: string;
  funded: number; factor: number | null; apr: number | null; termDays: number | null; frequency: string; payback: number | null;
  commRate: number; psfPct: number; originationFee: number; lineRate: number | null; lineFee: number; gross: number; referralPartner: string | null; referralRate: number; referralFee: number; net: number;
  roles: RoleView[]; totalRepPayout: number; houseNet: number; collected: number; outstanding: number; lenderPaidLabel: string;
  commissionStatus: string; dealStatus: string; storedDealStatus: string; atRisk: boolean; repPaid: string | null; lenderPaid: string | null; crmId: string | null; crmUrl: string;
  creditLine: number | null; drawSubsequentPct: number | null; hasClawback: boolean; clawbackWindow: ClawbackWindow; overdueReceipts: number; overdueAmount: number; increments: { total: number; lenderPaid: number; repPaid: number; disbursed: number; planned: number; perIncrement: number; stopped: boolean } | null;
}
export interface ScheduleEvent { kind: 'upfront' | 'increment' | 'remainder'; n: number; label: string; expected: string | null; amount: number; received: boolean; overdue: boolean; funding?: number }
export interface Disbursement { planned: number; perIncrement: number; disbursed: number; final: number; count: number; total: number; stopped: boolean; uneven: boolean }
export interface ScheduleView { disbursement: Disbursement; amounts: number[] | null; planned: { amount: number; gross: number; referralFee: number; net: number; increments: number } | null; weeks: number; received: number; startDate: string | null; perWeek: number; cadenceDays: number; upfrontPct: number; upfrontAmount: number; upfrontReceived: boolean; remainder: 'spread' | 'at-end'; remainderAmount: number; remainderReceived: boolean; events: ScheduleEvent[]; nextExpected: ScheduleEvent | null; overdue: number; overdueAmount: number; paidToReps: Array<{ role: Role; repId: string; name: string | null; paid: number; total: number }> }
export interface SegmentView { sk: string; label: string; n: number; date: string; amount: number; commRate: number; gross: number; referralFee: number; net: number; collected: number; outstanding: number; status: string; lenderPaidLabel: string; schedule: ScheduleView | null; termDays: number | null; factor: number | null; payback: number | null; payment: number | null }
export interface AdminDealDetail extends AdminDealRow {
  segments: SegmentView[];
  payments: Array<{ role: string; segmentKey: string | null; unit: string | null; repId: string; repName: string; amount: number; paidAt: string; runId: string | null }>;
  clawbacks: Array<{ id: string; date: string; amount: number; recovered: number; reason: string; status: string; slices: Array<{ repId: string; name: string; share: number; recovered: number; remaining: number }> }>;
}
export interface RepOption { id: string; label: string }
export interface MasterBoard { count: number; deals: AdminDealRow[]; repOptions: { assign: RepOption[]; edit: RepOption[] } }
export interface NewDealDraft {
  business: string; merchantContact?: string; merchantEmail?: string; merchantPhone?: string; fundedDate: string; lender: string; product: string; parentId?: string | null;
  amount: number; termDays?: number | null; factor?: number | null; apr?: number | null; frequency?: string; commRate?: number | null; psfPct?: number | null; originationFee?: number | null;
  referralPartner?: string | null; referralRate?: number | null; creditLine?: number | null; drawInitialPct?: number | null; drawSubsequentPct?: number | null; lineRate?: number | null;
  openerId?: string | null; openerRate?: number | null; closerId?: string | null; closerRate?: number | null; overrideId?: string | null; overrideRate?: number | null; leadSource?: string | null; notes?: string | null;
  commIncrements?: number | null; commUpfrontPct?: number | null; commRemainder?: 'spread' | 'at-end' | null; commCadenceDays?: number | null; commStartDate?: string | null; commAmounts?: number[] | null;
}
export const post = <T,>(path: string, body: unknown, method = 'POST') => api<T>(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

/* ---- Payroll (Phase 5). Admin only. ---- */
export interface RunSummary { id: string; label: string; start: string; end: string; status: 'draft' | 'approved' | 'paid'; paidGross: number; recovered: number; cash: number; repCount: number; lineCount: number }
export interface PayrollRepRow { id: string; name: string; active: boolean; owed: number; held: number; lineCount: number }
export interface PayrollOverview { runs: RunSummary[]; reps: PayrollRepRow[]; outstanding: number }
export interface PayableLineView { key: string; dealId: string; segmentKey: string; segmentLabel: string; business: string; merchantContact: string; merchantEmail: string; merchantPhone: string; lender: string; funded: number; role: string; rate: number; amount: number; lenderPaidLabel: string; collected: boolean; collectedKeys: string[]; collectedAmount: number; uncollectedKeys: string[]; uncollectedAmount: number; units: { paid: number; total: number; collected: number } | null }
export interface PayrollRepDetail {
  rep: { id: string; name: string; active: boolean };
  lines: PayableLineView[];
  clawbacks: Array<{ id: string; dealId: string; business: string; date: string; remaining: number }>;
  outstandingClawback: number;
  paidInRun: Array<{ key: string; dealId: string; business: string; merchantContact: string; merchantEmail: string; merchantPhone: string; role: string; voided: boolean; voids: string | null; segmentKey: string | null; unitLabel: string | null; amount: number; paidAt: string }>;
  paidSummary: { gross: number; recovered: number; cash: number; lineCount: number; voided: number };
}
export interface PayResult { repId: string; runId: string; gross: number; withheld: number; net: number; lines: number; recoveries: number; dealsFullyPaid: string[]; uncollectedDealIds: string[] }

/* ---- Renewals + pay history (Phase 6) ---- */
export type RenewalBucket = 'due' | 'prospecting' | 'building' | 'risk' | 'refinanced';
export interface RenewalBase { id: string; crmId: string | null; business: string; merchantContact: string; merchantEmail: string; merchantPhone: string; lender: string; product: string; date: string; funded: number; payback: number | null; termDays: number | null; frequency: string; factor: number | null; parentId: string | null; isParent: boolean; drawCount: number; pctPaidIn: number; markDate: string | null; maturityDate: string | null; daysToMark: number | null; bucket: RenewalBucket; bucketLabel: string; soon: boolean; prospectingDate: string; daysToProspecting: number; effectiveStatus: string; dealStatus: string }
export interface RepRenewalView extends RenewalBase { roles: Role[]; whoCalls: 'You' | 'Closer' | 'Opener'; estRenewalShare: number }
export interface AdminRenewalRow extends RenewalBase { whoCalls: string; estRenewalGross: number; crmUrl: string }
export interface PayHistoryRow { key: string; paidAt: string; dealId: string; business: string; role: string; segmentKey: string | null; segmentLabel: string; voided: boolean; amount: number; runId: string | null; runLabel: string | null }
export interface PayHistory { rows: PayHistoryRow[]; days: Array<{ date: string; runLabel: string | null; grossPaid: number; recovered: number; cash: number; rows: PayHistoryRow[] }>; summary: { grossPaid: number; recovered: number; cash: number; payouts: number } }

/** Statuses ops set by hand; Performing / Prospecting / Refi Ready follow the dates automatically. */
export const MANUAL_DEAL_STATUSES = ['Refinanced', 'Default', 'Slow Pay', 'Paid In Full'] as const;
export const DEAL_STATUS_OPTIONS = [{ value: 'Performing', label: 'Auto (Performing → Prospecting → Refi Ready)' }, ...MANUAL_DEAL_STATUSES.map((v) => ({ value: v, label: v }))];

/* ---- Merchants + overview (Phase 6b). Admin only. ---- */
export interface MerchantDealRow { id: string; crmId: string | null; date: string; business: string; lender: string; product: string; funded: number; gross: number; outstanding: number; commissionStatus: string; dealStatus: string; drawCount: number; crmUrl: string; renewedFromId: string | null; renewedById: string | null; prospectingDate: string; bucket: string; bucketLabel: string; ownerRepId: string | null; owner: string }
export interface MerchantRow { email: string; business: string; contact: string; phone: string; dealCount: number; funded: number; gross: number; outstanding: number; firstFunded: string; lastFunded: string; houseNet: number; openPositions: number; renewals: number; nextEligible: string | null; stage: string; deals: MerchantDealRow[] }
export interface MerchantDetail { merchant: MerchantRow; notes: Array<DealNoteView>; tasks: Array<{ id: string; dealId: string; title: string; dueDate: string; repName: string }>; files: Array<{ id: string; dealId: string; name: string; size: number; createdAt: string }> }
export interface Scorecard { repId: string; name: string; team: string | null; active: boolean; deals: number; funded: number; gross: number; renewable: number; renewed: number; renewalRate: number | null; tasksClosed: number; tasksWon: number; taskWinRate: number | null; onTimeRate: number | null; openTasks: number; overdueTasks: number; daysToClose: number | null }
export interface Overview {
  period: { from: string; to: string };
  cards: { funded: number; commissions: number; opportunities: number; drawLines: number; avgDealSize: number; avgFactor: number | null; paid: number; owed: number; clawbackExposure: number; renewalReady: number; renewalGross: number; expected30: number; expected30Count: number; overdueReceipts: number };
  monthly: Array<{ month: string; funded: number; commission: number }>;
  lenders: Array<{ lender: string; deals: number; funded: number; avgFactor: number | null; collectedPct: number }>;
  renewals: Array<{ id: string; crmId: string | null; business: string; lender: string; funded: number; markDate: string | null; whoCalls: string; estRenewalGross: number }>;
  clawbacks: Array<{ id: string; dealId: string; business: string; amount: number; repTotal: number; recovered: number; remaining: number; date: string }>;
}

/* ---- Settings (Phase 7). Admin only. ---- */
export interface Usage { lenders: Record<string, number>; partners: Record<string, number>; products: Record<string, number>; teams: Record<string, number> }
export interface Team { id: string; name: string; leaderRepId: string | null; overrideRate: number }
export interface RepRecord { id: string; name: string; email: string; role: 'rep' | 'manager' | 'admin'; teamId: string | null; openerRate: number; closerRate: number; overrideRate: number | null; active: boolean }

/* ---- Launch: notes, files, two-factor ---- */
export interface DealNoteView { id: string; dealId: string; authorRepId: string; author: string; body: string; createdAt: string }
export interface DealFileView { id: string; dealId: string; name: string; mime: string; size: number; uploadedBy: string; uploadedByName: string; createdAt: string }
export interface TotpStatus { enabled: boolean; pending: boolean }
export interface RemittanceRow { line: number; ref: string; date: string; amount: number; dealId: string | null; business: string | null; plan: string; steps: Array<{ segmentKey: string; label: string; amount: number }>; unapplied: number; problems: string[] }
export interface RemittancePreview { rows: RemittanceRow[]; problems: string[]; summary: { rows: number; matched: number; amount: number; applied: number; unapplied: number; problems: number } }
export interface AnnualRow { repId: string; name: string; email: string; active: boolean; grossPaid: number; recovered: number; cash: number; payouts: number; deals: number }
export interface AnnualReport { year: number; rows: AnnualRow[]; total: { grossPaid: number; recovered: number; cash: number; payouts: number; deals: number } }

/* ---- Books (bookkeeping). Admin only. ---- */
export type AgeBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';
export interface ReceivableRow { dealId: string; business: string; lender: string; product: string; fundedDate: string; segment: string; item: string; amount: number; expected: string | null; daysOverdue: number; bucket: AgeBucket }
export interface Receivables { asOf: string; rows: ReceivableRow[]; total: number; byBucket: Record<AgeBucket, number>; byLender: Array<{ lender: string; outstanding: number; overdue: number; termsDays: number; rows: number }> }
export interface PartnerPayableRow { dealId: string; business: string; lender: string; fundedDate: string; partner: string; fee: number; collected: boolean; commissionStatus: string; paidAt: string | null }
export interface PartnerPayables { rows: PartnerPayableRow[]; partners: Array<{ partner: string; pct: number; owed: number; owedCollected: number; paid: number; deals: number; active: boolean }>; totals: { owed: number; owedCollected: number; paid: number } }
export interface CashMonth { month: string; deals: number; funded: number; grossEarned: number; referralFees: number; repShares: number; houseNet: number; collected: number; outstanding: number; repPayouts: number; recovered: number; repCash: number }
export interface CashView { year: number; months: CashMonth[]; total: Omit<CashMonth, 'month'> }
export type ExceptionKind = 'funded-no-commission' | 'paid-before-collected' | 'past-maturity' | 'clawback-closing' | 'overdue-receipt' | 'partner-owed-collected';
export interface ExceptionItem { kind: ExceptionKind; dealId: string; business: string; lender: string; amount: number; detail: string; days: number }
export interface Exceptions { asOf: string; items: ExceptionItem[]; counts: Record<ExceptionKind, number>; totals: Record<ExceptionKind, number> }
export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  'funded-no-commission': 'Funded, nothing received from the lender',
  'paid-before-collected': 'Reps paid before the lender paid',
  'past-maturity': 'Past maturity, still Performing',
  'clawback-closing': 'Clawback window closes this week',
  'overdue-receipt': 'Lender receipt overdue',
  'partner-owed-collected': 'Partner fee owed on collected commission',
};
export const EXCEPTION_SHORT: Record<ExceptionKind, string> = { 'funded-no-commission': 'Nothing received', 'paid-before-collected': 'Paid ahead of lender', 'past-maturity': 'Past maturity', 'clawback-closing': 'Clawback closing', 'overdue-receipt': 'Receipt overdue', 'partner-owed-collected': 'Partner fee due' };
export interface RepFileView { id: string; repId: string; name: string; mime: string; size: number; uploadedBy: string; uploadedByName?: string; createdAt: string }
export interface AnnualMe { year: number; years: string[]; grossPaid: number; recovered: number; cash: number; payouts: number; deals: number }

/* ---- Playbooks and tasks ---- */
export type { PlaybookAction, PlaybookFilters, PlaybookRule, PlaybookTrigger } from '../../../api-server/src/services/playbook-rules';
export { MERGE_FIELD_HELP, TASK_OUTCOMES, TRIGGER_KINDS } from '../../../api-server/src/services/playbook-rules';
export interface PlaybookView { id: string; name: string; enabled: boolean; rule: PlaybookRuleT; createdAt: string; updatedAt: string; firings: number; lastFired: string | null; openTasks: number; doneTasks: number }
export interface PlaybookList { playbooks: PlaybookView[]; triggers: Array<{ kind: PlaybookRuleT['trigger']['kind']; label: string; param?: 'atLeast' | 'atMost' | 'withinDays' | 'in'; unit?: string }>; outcomes: Array<{ value: TaskOutcome; label: string; closes: boolean }>; mergeFields: string[]; lastRun: string | null }
export interface DryRunRow { dealId: string; business: string; lender: string; funded: number; rep: string; stage: string; paidIn: string; daysSinceFunding: number; held: string | null }
export interface DryRun { rows: DryRunRow[]; wouldFire: number; matched: number; preview: { subject: string; body: string } | null }
export interface RunResult { date: string; fired: number; emails: number; tasks: number; statuses: number; byPlaybook: Array<{ id: string; name: string; deals: number }> }
export interface FiringView { id: string; playbookId: string; dealId: string; repId: string | null; firedAt: string; detail?: Record<string, unknown> | null; playbookName: string; repName: string | null }
export type TaskOutcome = 'called' | 'no_answer' | 'app_submitted' | 'funded' | 'declined' | 'not_interested';
export interface TaskView { id: string; dealId: string; repId: string; playbookId: string | null; title: string; dueDate: string; status: 'open' | 'done'; outcome: TaskOutcome | null; note: string | null; createdBy: string | null; createdAt: string; doneAt: string | null; business: string; lender: string; funded: number; repName: string; playbookName: string | null; overdue: boolean; merchantContact: string; merchantPhone: string; merchantEmail: string }
export interface MyTasks { tasks: TaskView[]; outcomes: Array<{ value: TaskOutcome; label: string; closes: boolean }>; today: string }
export interface MerchantPreview { to: string; subject: string; body: string; template: MerchantTemplate }
