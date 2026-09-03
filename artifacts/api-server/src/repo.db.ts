import { desc, eq, sql } from 'drizzle-orm';
import type { LedgerContext, PayrollRun, Rep, Team } from '@greystone/commission';
import {
  commissionAuditLog,
  commissionClawbacks,
  commissionDealDraws,
  commissionDeals,
  commissionPayoutLines,
  commissionPayrollRuns,
  commissionReps,
  commissionSettings,
  commissionTeams,
  toClawback,
  toDeal,
  toPayoutLine,
  toRep,
  toTeam,
  type Database,
} from '@greystone/db';
import type { AuditEntry, Repo } from './repo.js';

export function dbRepo(db: Database): Repo {
  return {
    async findRepByEmail(email) {
      const rows = await db
        .select()
        .from(commissionReps)
        .where(sql`lower(${commissionReps.email}) = ${email.trim().toLowerCase()}`)
        .limit(1);
      return rows[0] ? toRep(rows[0]) : null;
    },
    async findRep(id) {
      const rows = await db.select().from(commissionReps).where(eq(commissionReps.id, id)).limit(1);
      return rows[0] ? toRep(rows[0]) : null;
    },
    async listReps() {
      return (await db.select().from(commissionReps).orderBy(commissionReps.name)).map(toRep);
    },
    async listTeams(): Promise<Team[]> {
      return (await db.select().from(commissionTeams).orderBy(commissionTeams.name)).map(toTeam);
    },
    async listRuns(): Promise<PayrollRun[]> {
      const rows = await db.select().from(commissionPayrollRuns).orderBy(desc(commissionPayrollRuns.start));
      return rows.map((r) => ({ id: r.id, label: r.label, start: r.start, end: r.end, status: r.status as PayrollRun['status'] }));
    },
    async loadContext(): Promise<LedgerContext> {
      const [deals, draws, lines, clawbacks] = await Promise.all([
        db.select().from(commissionDeals).orderBy(desc(commissionDeals.date), desc(commissionDeals.id)),
        db.select().from(commissionDealDraws),
        db.select().from(commissionPayoutLines),
        db.select().from(commissionClawbacks),
      ]);
      return { deals: deals.map((d) => toDeal(d, draws)), lines: lines.map(toPayoutLine), clawbacks: clawbacks.map(toClawback) };
    },
    async getSetting<T>(key: string): Promise<T | null> {
      const rows = await db.select().from(commissionSettings).where(eq(commissionSettings.key, key)).limit(1);
      return rows[0] ? (rows[0].value as T) : null;
    },
    async writeAudit(entry: AuditEntry) {
      await db.insert(commissionAuditLog).values({
        actorRepId: entry.actorRepId,
        action: entry.action,
        targetRepId: entry.targetRepId,
        path: entry.path,
        detail: entry.detail ?? null,
      });
    },
    async listAudit(limit = 100) {
      const rows = await db.select().from(commissionAuditLog).orderBy(desc(commissionAuditLog.at)).limit(limit);
      return rows.map((r) => ({
        actorRepId: r.actorRepId,
        action: r.action as AuditEntry['action'],
        targetRepId: r.targetRepId,
        path: r.path,
        detail: r.detail ?? undefined,
        at: r.at.toISOString(),
      }));
    },
  };
}
