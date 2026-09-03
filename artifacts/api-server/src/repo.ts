import type { Clawback, Deal, DealDraw, Lender, LedgerContext, PayoutLine, PayrollRun, ProductRule, ReferralPartner, Rep, Team, WeeklySchedule } from '@greystone/commission';

export interface AuditEntry {
  actorRepId: string;
  action: 'login' | 'logout' | 'view-as' | 'deal.create' | 'deal.update' | 'deal.draw' | 'deal.collection' | 'payroll.run' | 'payroll.pay' | 'settings.update' | 'team.update' | 'rep.update' | 'rep.password' | 'login.failed' | 'deal.delete' | 'payroll.void' | 'deal.import' | 'password.reset' | 'rep.totp' | 'deal.note' | 'deal.file' | 'deal.clawback' | 'deal.remittance' | 'mail.sent';
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

/** A "forgot password" token on file (only its hash). */
export interface PasswordReset { id: string; repId: string; tokenHash: string; expiresAt: string; usedAt: string | null }
/** Two-factor state for a rep. `enabled` flips only after a code has been verified. */
export interface TotpState { secret: string | null; enabled: boolean }
export interface DealNote { id: string; dealId: string; authorRepId: string; body: string; createdAt: string }
export interface DealFileMeta { id: string; dealId: string; name: string; mime: string; size: number; uploadedBy: string; createdAt: string }
export interface DealFile extends DealFileMeta { data: string }

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
  /** Removes the deal and its draws. Callers must first prove nothing in the ledger references it. */
  deleteDeal(id: string): Promise<void>;
  insertClawback(c: Clawback): Promise<void>;
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
  // Password sign-in. Hashes never travel on Rep — only these three calls see them.
  getPasswordHash(repId: string): Promise<string | null>;
  setPasswordHash(repId: string, hash: string | null): Promise<void>;
  repsWithPassword(): Promise<string[]>;
  /* Forgot-password tokens */
  createPasswordReset(r: PasswordReset): Promise<void>;
  findPasswordReset(tokenHash: string): Promise<PasswordReset | null>;
  consumePasswordReset(id: string): Promise<void>;
  /* Two-factor */
  getTotp(repId: string): Promise<TotpState>;
  setTotp(repId: string, state: TotpState): Promise<void>;
  repsWithTotp(): Promise<string[]>;
  /* Deal notes and files */
  listNotes(dealId: string): Promise<DealNote[]>;
  insertNote(n: DealNote): Promise<void>;
  deleteNote(id: string): Promise<void>;
  listFiles(dealId: string): Promise<DealFileMeta[]>;
  getFile(id: string): Promise<DealFile | null>;
  insertFile(f: DealFile): Promise<void>;
  deleteFile(id: string): Promise<void>;
}

export interface PayoutCommit {
  lines: PayoutLine[];
  clawbackUpdates: Array<Pick<Clawback, 'id' | 'recovered' | 'status'>>;
  dealsFullyPaid: string[];
  /** Deals whose repPaid stamp is cleared (a void undid the last line). */
  dealsUnstamped?: string[];
  paidAt: string;
}
