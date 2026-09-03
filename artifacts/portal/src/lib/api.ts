/* Types mirror artifacts/api-server/src/scope.ts. */
export type Role = 'Opener' | 'Closer' | 'Override';
export type CommissionStatus = 'Waiting for payment' | 'Invoice Sent' | 'Partially Paid' | 'YES - Paid In Full';
export type PayoutStatus = 'Paid' | 'Partially paid' | 'Owed';

export interface SessionUser { repId: string; email: string; name: string; role: 'rep' | 'manager' | 'admin' }
export interface AuthMe { user: SessionUser; canViewAs: boolean; oidc: boolean; devAuth: boolean }
export interface RepRoleLine { role: Role; rate: number; amount: number; segment: string; segmentKey: string; paid: boolean }
export interface RepDealView {
  id: string; crmId: string | null; date: string; business: string; lender: string; product: string; funded: number; drawCount: number;
  roles: Role[]; lines: RepRoleLine[]; share: number; paid: number; owed: number; payoutStatus: PayoutStatus;
  commissionStatus: CommissionStatus; lenderPaidLabel: string; dealStatus: string; repPaid: string | null;
  clawback: { amount: number; remaining: number; status: 'open' | 'recovered' } | null;
}
export interface RepDealDetail extends RepDealView { payments: Array<{ role: string; segmentKey: string | null; amount: number; paidAt: string; runId: string | null }> }
export interface RepWallet { earned: number; paid: number; cash: number; held: number; recovered: number; owed: number; dealCount: number; awaitingLender: number }
export interface LeaderboardRow { rank: number; label: string; isMe: boolean; commission: number }
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
export interface RosterRep { id: string; name: string; email: string; role: string; team: string | null; openerRate: number; closerRate: number; overrideRate: number | null; active: boolean; earned: number; paid: number; held: number; owed: number; dealCount: number }

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
export interface Lender { name: string; terms: 'upfront' | 'weekly'; weeks: number }
export interface ReferralPartner { name: string; pct: number; monthlyCap: number | null }
export interface ProductRule { name: string; basis: 'funded' | 'draw' | 'payback'; factor: boolean; term: boolean; parent: boolean; comm: number; clawback: boolean; renewal: boolean; multiDraw: boolean; drawInitial: number | null; drawSubsequent: number | null }
export interface Settings {
  lenders: Lender[]; partners: ReferralPartner[]; products: ProductRule[];
  thresholds: { clawbackWindowDays: number; paymentOverdueDays: number; renewalMark: number; additionalCapitalAfterDays: number };
  lists: { frequencies: string[]; commissionStatuses: string[]; dealStatuses: string[] };
  crm: { urlTemplate: string }; payroll: { cycle: string };
}
export interface RoleView { role: Role; repId: string | null; name: string | null; rate: number; amount: number; paid: number }
export interface AdminDealRow {
  id: string; opportunityId: string; parentId: string | null; date: string; business: string; drawCount: number;
  merchantContact: string; merchantEmail: string; merchantPhone: string; lender: string; product: string;
  funded: number; factor: number | null; apr: number | null; termDays: number | null; frequency: string; payback: number | null;
  commRate: number; psfPct: number; originationFee: number; gross: number; referralPartner: string | null; referralRate: number; referralFee: number; net: number;
  roles: RoleView[]; totalRepPayout: number; houseNet: number; collected: number; outstanding: number; lenderPaidLabel: string;
  commissionStatus: string; dealStatus: string; storedDealStatus: string; atRisk: boolean; repPaid: string | null; lenderPaid: string | null; crmId: string | null; crmUrl: string;
  creditLine: number | null; drawSubsequentPct: number | null; hasClawback: boolean;
}
export interface SegmentView { sk: string; label: string; n: number; date: string; amount: number; commRate: number; gross: number; referralFee: number; net: number; collected: number; outstanding: number; status: string; lenderPaidLabel: string; schedule: { weeks: number; received: number; startDate: string | null; perWeek: number } | null; termDays: number | null; factor: number | null; payback: number | null; payment: number | null }
export interface AdminDealDetail extends AdminDealRow {
  segments: SegmentView[];
  payments: Array<{ role: string; segmentKey: string | null; repId: string; repName: string; amount: number; paidAt: string; runId: string | null }>;
  clawbacks: Array<{ id: string; date: string; amount: number; recovered: number; reason: string; status: string; slices: Array<{ repId: string; name: string; share: number; recovered: number; remaining: number }> }>;
}
export interface RepOption { id: string; label: string }
export interface MasterBoard { count: number; deals: AdminDealRow[]; repOptions: { assign: RepOption[]; edit: RepOption[] } }
export interface NewDealDraft {
  business: string; merchantContact?: string; merchantEmail?: string; merchantPhone?: string; fundedDate: string; lender: string; product: string; parentId?: string | null;
  amount: number; termDays?: number | null; factor?: number | null; apr?: number | null; frequency?: string; commRate?: number | null; psfPct?: number | null; originationFee?: number | null;
  referralPartner?: string | null; referralRate?: number | null; creditLine?: number | null; drawInitialPct?: number | null; drawSubsequentPct?: number | null;
  openerId?: string | null; openerRate?: number | null; closerId?: string | null; closerRate?: number | null; overrideId?: string | null; overrideRate?: number | null; leadSource?: string | null; notes?: string | null;
}
export const post = <T,>(path: string, body: unknown, method = 'POST') => api<T>(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

/* ---- Payroll (Phase 5). Admin only. ---- */
export interface RunSummary { id: string; label: string; start: string; end: string; status: 'draft' | 'approved' | 'paid'; paidGross: number; recovered: number; cash: number; repCount: number; lineCount: number }
export interface PayrollRepRow { id: string; name: string; active: boolean; owed: number; held: number; lineCount: number }
export interface PayrollOverview { runs: RunSummary[]; reps: PayrollRepRow[]; outstanding: number }
export interface PayableLineView { key: string; dealId: string; segmentKey: string; segmentLabel: string; business: string; merchantContact: string; merchantEmail: string; merchantPhone: string; lender: string; funded: number; role: string; rate: number; amount: number; lenderPaidLabel: string; collected: boolean }
export interface PayrollRepDetail {
  rep: { id: string; name: string; active: boolean };
  lines: PayableLineView[];
  clawbacks: Array<{ id: string; dealId: string; business: string; date: string; remaining: number }>;
  outstandingClawback: number;
  paidInRun: Array<{ key: string; dealId: string; business: string; merchantContact: string; role: string; segmentKey: string | null; amount: number; paidAt: string }>;
  paidSummary: { gross: number; recovered: number; cash: number; lineCount: number };
}
export interface PayResult { repId: string; runId: string; gross: number; withheld: number; net: number; lines: number; recoveries: number; dealsFullyPaid: string[]; uncollectedDealIds: string[] }

/* ---- Renewals + pay history (Phase 6) ---- */
export type RenewalBucket = 'due' | 'prospecting' | 'building' | 'risk' | 'refinanced';
export interface RenewalBase { id: string; crmId: string | null; business: string; merchantContact: string; merchantEmail: string; merchantPhone: string; lender: string; product: string; date: string; funded: number; payback: number | null; termDays: number | null; frequency: string; factor: number | null; parentId: string | null; isParent: boolean; drawCount: number; pctPaidIn: number; markDate: string | null; maturityDate: string | null; daysToMark: number | null; bucket: RenewalBucket; bucketLabel: string; soon: boolean; prospectingDate: string; daysToProspecting: number; effectiveStatus: string; dealStatus: string }
export interface RepRenewalView extends RenewalBase { roles: Role[]; whoCalls: 'You' | 'Closer' | 'Opener'; estRenewalShare: number }
export interface AdminRenewalRow extends RenewalBase { whoCalls: string; estRenewalGross: number; crmUrl: string }
export interface PayHistoryRow { key: string; paidAt: string; dealId: string; business: string; role: string; segmentKey: string | null; segmentLabel: string; amount: number; runId: string | null; runLabel: string | null }
export interface PayHistory { rows: PayHistoryRow[]; days: Array<{ date: string; runLabel: string | null; grossPaid: number; recovered: number; cash: number; rows: PayHistoryRow[] }>; summary: { grossPaid: number; recovered: number; cash: number; payouts: number } }

/** Statuses ops set by hand; Performing / Prospecting / Refi Ready follow the dates automatically. */
export const MANUAL_DEAL_STATUSES = ['Refinanced', 'Default', 'Slow Pay', 'Paid In Full'] as const;
export const DEAL_STATUS_OPTIONS = [{ value: 'Performing', label: 'Auto (Performing → Prospecting → Refi Ready)' }, ...MANUAL_DEAL_STATUSES.map((v) => ({ value: v, label: v }))];

/* ---- Merchants + overview (Phase 6b). Admin only. ---- */
export interface MerchantDealRow { id: string; crmId: string | null; date: string; business: string; lender: string; product: string; funded: number; gross: number; outstanding: number; commissionStatus: string; dealStatus: string; drawCount: number; crmUrl: string }
export interface MerchantRow { email: string; business: string; contact: string; phone: string; dealCount: number; funded: number; gross: number; outstanding: number; firstFunded: string; lastFunded: string; deals: MerchantDealRow[] }
export interface Overview {
  period: { from: string; to: string };
  cards: { funded: number; commissions: number; opportunities: number; drawLines: number; avgDealSize: number; avgFactor: number | null; paid: number; owed: number; clawbackExposure: number; renewalReady: number; renewalGross: number };
  monthly: Array<{ month: string; funded: number; commission: number }>;
  lenders: Array<{ lender: string; deals: number; funded: number; avgFactor: number | null; collectedPct: number }>;
  renewals: Array<{ id: string; crmId: string | null; business: string; lender: string; funded: number; markDate: string | null; whoCalls: string; estRenewalGross: number }>;
  clawbacks: Array<{ id: string; dealId: string; business: string; amount: number; repTotal: number; recovered: number; remaining: number; date: string }>;
}
