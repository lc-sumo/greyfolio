import type { LedgerContext, PayrollRun, Rep, Team } from '@greystone/commission';

export interface AuditEntry {
  actorRepId: string;
  action: 'login' | 'logout' | 'view-as';
  targetRepId: string | null;
  path: string | null;
  detail?: Record<string, unknown>;
  at?: string;
}

/**
 * What the API needs from storage. `dbRepo` implements it over Drizzle; tests
 * use an in-memory implementation. Routes never touch the database directly.
 */
export interface Repo {
  findRepByEmail(email: string): Promise<Rep | null>;
  findRep(id: string): Promise<Rep | null>;
  listReps(): Promise<Rep[]>;
  listTeams(): Promise<Team[]>;
  listRuns(): Promise<PayrollRun[]>;
  loadContext(): Promise<LedgerContext>;
  getSetting<T>(key: string): Promise<T | null>;
  writeAudit(entry: AuditEntry): Promise<void>;
  listAudit(limit?: number): Promise<AuditEntry[]>;
}
