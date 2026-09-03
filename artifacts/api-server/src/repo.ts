import type { Clawback, Deal, DealDraw, Lender, LedgerContext, PayoutLine, PayrollRun, ProductRule, ReferralPartner, Rep, Team, WeeklySchedule } from '@greystone/commission';

export interface AuditEntry {
  actorRepId: string;
  action: 'login' | 'logout' | 'view-as' | 'deal.create' | 'deal.update' | 'deal.draw' | 'deal.collection' | 'payroll.run' | 'payroll.pay' | 'settings.update' | 'team.update' | 'rep.update';
  targetRepId: string | null;
  path: string | null;
  detail?: Record<string, unknown>;
  at?: string;
}

export interface Thresholds {
  clawbackWindowDays: number;
  paymentOverdueDays: number;
  renewalMark: number;
  additionalCapitalAfterDays: number;
}

export interface Settings {
  lenders: Lender[];
  partners: ReferralPartner[];
  products: ProductRule[];
  thresholds: Thresholds;
  lists: { frequencies: string[]; commissionStatuses: string[]; dealStatuses: string[] };
  crm: { urlTemplate: string };
  payroll: { cycle: string };
}

/** Stored deal columns that a service may patch (never draws — those have their own methods). */
export type DealPatch = Partial<Omit<Deal, 'id' | 'draws'>>;

/**
 * What the API needs from storage. `dbRepo` implements it over Drizzle; the
 * in-memory implementation serves tests and the browser demo. Routes never
 * touch the database directly.
 */
export interface Repo {
  findRepByEmail(email: string): Promise<Rep | null>;
  findRep(id: string): Promise<Rep | null>;
  listReps(): Promise<Rep[]>;
  listTeams(): Promise<Team[]>;
  listRuns(): Promise<PayrollRun[]>;
  loadContext(): Promise<LedgerContext>;
  getSetting<T>(key: string): Promise<T | null>;
  getSettings(): Promise<Settings>;
  writeAudit(entry: AuditEntry): Promise<void>;
  listAudit(limit?: number): Promise<AuditEntry[]>;
  // Deal writes (admin only — enforced by the routes)
  insertDeal(deal: Deal): Promise<void>;
  updateDeal(id: string, patch: DealPatch): Promise<void>;
  insertDraw(dealId: string, draw: DealDraw): Promise<void>;
  updateDraw(dealId: string, ref: string, patch: { collected: number | null; schedule: WeeklySchedule | null }): Promise<void>;
  // Payroll (admin only — enforced by the routes)
  insertRun(run: PayrollRun): Promise<void>;
  updateRun(id: string, patch: Partial<Pick<PayrollRun, 'status' | 'label'>> & { approvedAt?: string | null; paidAt?: string | null }): Promise<void>;
  /** One transaction: append ledger rows, roll up clawbacks, stamp repPaid on fully paid deals. */
  commitPayout(commit: PayoutCommit): Promise<void>;
  // Settings, teams, reps (admin only — enforced by the routes)
  putSetting(key: string, value: unknown): Promise<void>;
  insertTeam(team: Team): Promise<void>;
  updateTeam(id: string, patch: Partial<Omit<Team, 'id'>>): Promise<void>;
  deleteTeam(id: string): Promise<void>;
  insertRep(rep: Rep): Promise<void>;
  updateRep(id: string, patch: Partial<Omit<Rep, 'id'>>): Promise<void>;
}

export interface PayoutCommit {
  lines: PayoutLine[];
  clawbackUpdates: Array<Pick<Clawback, 'id' | 'recovered' | 'status'>>;
  dealsFullyPaid: string[];
  paidAt: string;
}
