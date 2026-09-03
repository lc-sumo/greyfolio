import { desc, eq, sql } from 'drizzle-orm';
import type { Deal, DealDraw, LedgerContext, PayrollRun, Rep, Team, WeeklySchedule } from '@greystone/commission';
import {
  commissionAuditLog,
  commissionClawbacks,
  commissionDealDraws,
  commissionDeals,
  commissionPayoutLines,
  commissionPayrollRuns,
  commissionPayrollRuns as runsTable,
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
import type { AuditEntry, DealPatch, PayoutCommit, Repo, Settings } from './repo.js';

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
    async getSettings(): Promise<Settings> {
      const rows = await db.select().from(commissionSettings);
      const map = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Partial<Settings>;
      return {
        lenders: map.lenders ?? [],
        partners: map.partners ?? [],
        products: map.products ?? [],
        thresholds: map.thresholds ?? { clawbackWindowDays: 30, paymentOverdueDays: 14, renewalMark: 0.4, additionalCapitalAfterDays: 30 },
        lists: map.lists ?? { frequencies: [], commissionStatuses: [], dealStatuses: [] },
        crm: map.crm ?? { urlTemplate: '' },
        payroll: map.payroll ?? { cycle: 'Twice monthly' },
      };
    },
    async insertDeal(deal: Deal) {
      const { draws, ...row } = deal;
      await db.transaction(async (tx) => {
        await tx.insert(commissionDeals).values(row);
        for (const x of draws) await tx.insert(commissionDealDraws).values({ dealId: deal.id, ...x });
      });
    },
    async updateDeal(id: string, patch: DealPatch) {
      await db.update(commissionDeals).set({ ...patch, updatedAt: sql`now()` }).where(eq(commissionDeals.id, id));
    },
    async insertDraw(dealId: string, draw: DealDraw) {
      await db.insert(commissionDealDraws).values({ dealId, ...draw });
    },
    async updateDraw(dealId: string, ref: string, patch: { collected: number | null; schedule: WeeklySchedule | null }) {
      await db.update(commissionDealDraws).set(patch).where(sql`${commissionDealDraws.dealId} = ${dealId} and ${commissionDealDraws.ref} = ${ref}`);
    },
    async putSetting(key: string, value: unknown) {
      await db
        .insert(commissionSettings)
        .values({ key, value: value as never })
        .onConflictDoUpdate({ target: commissionSettings.key, set: { value: value as never, updatedAt: sql`now()` } });
    },
    async insertTeam(team: Team) {
      await db.insert(commissionTeams).values({ id: team.id, name: team.name, leaderRepId: team.leaderRepId, overrideRate: team.overrideRate });
    },
    async updateTeam(id: string, patch: Partial<Omit<Team, 'id'>>) {
      await db.update(commissionTeams).set(patch).where(eq(commissionTeams.id, id));
    },
    async deleteTeam(id: string) {
      await db.delete(commissionTeams).where(eq(commissionTeams.id, id));
    },
    async insertRep(rep: Rep) {
      await db.insert(commissionReps).values({ id: rep.id, name: rep.name, email: rep.email, role: rep.role, teamId: rep.teamId, openerRate: rep.openerRate, closerRate: rep.closerRate, overrideRate: rep.overrideRate, active: rep.active });
    },
    async updateRep(id: string, patch: Partial<Omit<Rep, 'id'>>) {
      await db.update(commissionReps).set({ ...patch, updatedAt: sql`now()` }).where(eq(commissionReps.id, id));
    },
    async getPasswordHash(repId: string) {
      const rows = await db.select({ h: commissionReps.passwordHash }).from(commissionReps).where(eq(commissionReps.id, repId)).limit(1);
      return rows[0]?.h ?? null;
    },
    async setPasswordHash(repId: string, hash: string | null) {
      await db.update(commissionReps).set({ passwordHash: hash, updatedAt: sql`now()` }).where(eq(commissionReps.id, repId));
    },
    async repsWithPassword() {
      const rows = await db.select({ id: commissionReps.id }).from(commissionReps).where(sql`${commissionReps.passwordHash} is not null`);
      return rows.map((r) => r.id);
    },
    async insertRun(run: PayrollRun) {
      await db.insert(commissionPayrollRuns).values({ id: run.id, label: run.label, start: run.start, end: run.end, status: run.status });
    },
    async updateRun(id, patch) {
      await db
        .update(runsTable)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.label ? { label: patch.label } : {}),
          ...(patch.approvedAt !== undefined ? { approvedAt: patch.approvedAt ? new Date(patch.approvedAt) : null } : {}),
          ...(patch.paidAt !== undefined ? { paidAt: patch.paidAt ? new Date(patch.paidAt) : null } : {}),
        })
        .where(eq(runsTable.id, id));
    },
    async commitPayout(c: PayoutCommit) {
      await db.transaction(async (tx) => {
        for (const l of c.lines) {
          await tx.insert(commissionPayoutLines).values({ key: l.key, dealId: l.dealId, segmentKey: l.segmentKey, role: l.role, repId: l.repId, amount: l.amount, runId: l.runId, clawbackId: l.clawbackId, paidAt: l.paidAt });
        }
        for (const u of c.clawbackUpdates) await tx.update(commissionClawbacks).set({ recovered: u.recovered, status: u.status }).where(eq(commissionClawbacks.id, u.id));
        for (const id of c.dealsFullyPaid) await tx.update(commissionDeals).set({ repPaid: c.paidAt, updatedAt: sql`now()` }).where(sql`${commissionDeals.id} = ${id} and ${commissionDeals.repPaid} is null`);
      });
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
