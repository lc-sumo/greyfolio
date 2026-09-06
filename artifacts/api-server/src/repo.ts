import type { Clawback, Deal, DealDraw, Lender, LedgerContext, PayoutLine, PayrollRun, ProductRule, ReferralPartner, Rep, Team, WeeklySchedule } from '@greystone/commission';
import type { PlaybookRule } from './services/playbook-rules.js';

export interface AuditEntry {
  actorRepId: string;
  action: 'login' | 'logout' | 'view-as' | 'deal.create' | 'deal.update' | 'deal.draw' | 'deal.collection' | 'payroll.run' | 'payroll.pay' | 'settings.update' | 'team.update' | 'rep.update' | 'rep.password' | 'login.failed' | 'deal.delete' | 'payroll.void' | 'deal.import' | 'password.reset' | 'rep.totp' | 'deal.note' | 'deal.file' | 'deal.clawback' | 'deal.remittance' | 'mail.sent' | 'deal.draw.delete' | 'payroll.run.delete' | 'deal.contact' | 'deal.draw.update' | 'deal.clawback.update' | 'deal.clawback.delete' | 'payroll.run.reopen' | 'settings.rename' | 'rep.invite' | 'rep.device' | 'session.idle' | 'rep.file' | 'rep.calendar' | 'deal.referral.paid' | 'settings.playbook' | 'playbook.fired' | 'task' | 'mail.merchant' | 'backup';
  targetRepId: string | null;
  path: string | null;
  detail?: Record<string, unknown>;
  at?: string;
  /** Client IP; filled from the request context when the writer does not pass one. */
  ip?: string | null;
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
  /** Names shown in the sidebar, sign-in screen and emails. */
  portal: { company: string; portal: string; supportEmail: string };
  /** Which automatic emails go out, and when the renewal digest lands (UTC hour). */
  notifications: { statements: boolean; clawbacks: boolean; renewalDigest: boolean; digestHourUtc: number; repQuestions: boolean; playbookHourUtc: number };
  security: {
    requireTotpForAdmins: boolean;
    /** Minutes of inactivity before a session is signed out; 0 = never. */
    idleMinutes: number;
    /** Days a device stays trusted after a two-factor sign-in; 0 = ask for a code every time. */
    totpRememberDays: number;
  };
  /** Email templates reps send to merchants from a deal. */
  templates: { merchant: Array<{ id: string; name: string; subject: string; body: string }> };
}

export const PORTAL_DEFAULTS: Settings['portal'] = { company: 'Greystone Merchant Partners', portal: 'Commission portal', supportEmail: '' };
export const NOTIFICATION_DEFAULTS: Settings['notifications'] = { statements: true, clawbacks: true, renewalDigest: true, digestHourUtc: 13, repQuestions: true, playbookHourUtc: 12 };
export const SECURITY_DEFAULTS: Settings['security'] = { requireTotpForAdmins: false, idleMinutes: 120, totpRememberDays: 7 };
export { TEMPLATE_DEFAULTS } from './services/playbooks.js';

/** A "forgot password" token on file (only its hash). */
export interface PasswordReset { id: string; repId: string; tokenHash: string; expiresAt: string; usedAt: string | null }
/** Two-factor state for a rep. `enabled` flips only after a code has been verified. */
export interface TotpState { secret: string | null; enabled: boolean }
/** A browser that may skip the authenticator code until `expiresAt`. */
export interface TrustedDevice { id: string; repId: string; tokenHash: string; label: string; ip: string | null; createdAt: string; lastUsedAt: string; expiresAt: string }
export interface DealNote { id: string; dealId: string; authorRepId: string; body: string; createdAt: string }
export interface DealFileMeta { id: string; dealId: string; name: string; mime: string; size: number; uploadedBy: string; createdAt: string }
export interface DealFile extends DealFileMeta { data: string }
/** A file on a rep's roster entry (W-9, agreement). */
export interface RepFileMeta { id: string; repId: string; name: string; mime: string; size: number; uploadedBy: string; createdAt: string }
export interface RepFile extends RepFileMeta { data: string }

/** An if/then rule (Settings › Playbooks). */
export interface Playbook { id: string; name: string; enabled: boolean; rule: PlaybookRule; createdAt: string; updatedAt: string }
/** One rule firing on one deal. */
export interface PlaybookFiring { id: string; playbookId: string; dealId: string; repId: string | null; firedAt: string; detail?: Record<string, unknown> | null }
export type TaskOutcome = 'called' | 'no_answer' | 'app_submitted' | 'funded' | 'declined' | 'not_interested';
/** A rep's to-do on a deal, from a playbook or by hand. */
export interface RepTask {
  id: string;
  dealId: string;
  repId: string;
  playbookId: string | null;
  title: string;
  dueDate: string;
  status: 'open' | 'done';
  outcome: TaskOutcome | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  doneAt: string | null;
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
  listAudit(limit?: number, offset?: number): Promise<AuditEntry[]>;
  // Deal writes (admin only — enforced by the routes)
  insertDeal(deal: Deal): Promise<void>;
  updateDeal(id: string, patch: DealPatch): Promise<void>;
  /** Removes the deal and its draws. Callers must first prove nothing in the ledger references it. */
  deleteDeal(id: string): Promise<void>;
  insertClawback(c: Clawback): Promise<void>;
  updateClawback(id: string, patch: Partial<Pick<Clawback, 'amount' | 'date' | 'reason'>>): Promise<void>;
  deleteClawback(id: string): Promise<void>;
  /** Cascade a settings rename onto the deals that reference the old name. Returns how many changed. */
  renameRef(kind: 'lender' | 'partner' | 'product', from: string, to: string): Promise<number>;
  insertDraw(dealId: string, draw: DealDraw): Promise<void>;
  updateDraw(dealId: string, ref: string, patch: { collected: number | null; schedule: WeeklySchedule | null }): Promise<void>;
  deleteDraw(dealId: string, ref: string): Promise<void>;
  /** Re-price a draw in place (same ref). */
  replaceDraw(dealId: string, ref: string, draw: DealDraw): Promise<void>;
  // Payroll (admin only — enforced by the routes)
  insertRun(run: PayrollRun): Promise<void>;
  updateRun(id: string, patch: Partial<Pick<PayrollRun, 'status' | 'label'>> & { approvedAt?: string | null; paidAt?: string | null }): Promise<void>;
  deleteRun(id: string): Promise<void>;
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
  /* Remembered devices for two-factor */
  listTrustedDevices(repId: string): Promise<TrustedDevice[]>;
  findTrustedDevice(tokenHash: string): Promise<TrustedDevice | null>;
  insertTrustedDevice(d: TrustedDevice): Promise<void>;
  touchTrustedDevice(id: string, patch: { lastUsedAt: string; ip: string | null }): Promise<void>;
  deleteTrustedDevice(id: string): Promise<void>;
  deleteTrustedDevices(repId: string): Promise<void>;
  /* Deal notes and files */
  listNotes(dealId: string): Promise<DealNote[]>;
  insertNote(n: DealNote): Promise<void>;
  deleteNote(id: string): Promise<void>;
  listFiles(dealId: string): Promise<DealFileMeta[]>;
  getFile(id: string): Promise<DealFile | null>;
  insertFile(f: DealFile): Promise<void>;
  deleteFile(id: string): Promise<void>;
  /* Whole-table reads for the backup download */
  listAllNotes(): Promise<DealNote[]>;
  listAllFiles(): Promise<DealFile[]>;
  listAllRepFiles(): Promise<RepFile[]>;
  /* Session cut-off: a password change signs every other device out */
  getSessionCutoff(repId: string): Promise<string | null>;
  setSessionCutoff(repId: string, at: string): Promise<void>;
  /* Private calendar feed */
  getCalendarToken(repId: string): Promise<string | null>;
  setCalendarToken(repId: string, token: string | null): Promise<void>;
  findRepByCalendarToken(token: string): Promise<Rep | null>;
  /* Rep files (W-9 etc.) */
  listRepFiles(repId: string): Promise<RepFileMeta[]>;
  getRepFile(id: string): Promise<RepFile | null>;
  insertRepFile(f: RepFile): Promise<void>;
  deleteRepFile(id: string): Promise<void>;
  /* Playbooks, their firings, and the tasks they open */
  listPlaybooks(): Promise<Playbook[]>;
  insertPlaybook(p: Playbook): Promise<void>;
  updatePlaybook(id: string, patch: Partial<Pick<Playbook, 'name' | 'enabled' | 'rule'>>): Promise<void>;
  deletePlaybook(id: string): Promise<void>;
  listFirings(opts?: { playbookId?: string; dealId?: string; limit?: number }): Promise<PlaybookFiring[]>;
  insertFiring(f: PlaybookFiring): Promise<void>;
  listTasks(filter?: { repId?: string; dealId?: string; status?: RepTask['status'] }): Promise<RepTask[]>;
  insertTask(t: RepTask): Promise<void>;
  updateTask(id: string, patch: Partial<Pick<RepTask, 'status' | 'outcome' | 'note' | 'doneAt' | 'dueDate' | 'title'>>): Promise<void>;
}

export interface PayoutCommit {
  lines: PayoutLine[];
  clawbackUpdates: Array<Pick<Clawback, 'id' | 'recovered' | 'status'>>;
  dealsFullyPaid: string[];
  /** Deals whose repPaid stamp is cleared (a void undid the last line). */
  dealsUnstamped?: string[];
  paidAt: string;
}
