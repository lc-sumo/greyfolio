import { desc, eq, sql } from 'drizzle-orm';
import type { Clawback, Deal, DealDraw, LedgerContext, PayrollRun, Rep, Team, WeeklySchedule } from '@greystone/commission';
import {
  commissionAuditLog,
  commissionClawbacks,
  commissionDealDraws,
  commissionDealFiles,
  commissionDealNotes,
  commissionDeals,
  commissionPasswordResets,
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
import type { AuditEntry, DealFile, DealNote, DealPatch, PasswordReset, PayoutCommit, Repo, Settings, TotpState } from './repo.js';

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
    async insertClawback(c: Clawback) {
      await db.insert(commissionClawbacks).values({ id: c.id, dealId: c.dealId, date: c.date, amount: c.amount, reason: c.reason, status: c.status, recovered: c.recovered });
    },
    async deleteDeal(id: string) {
      await db.transaction(async (tx) => {
        await tx.delete(commissionDealDraws).where(eq(commissionDealDraws.dealId, id));
        await tx.delete(commissionDeals).where(eq(commissionDeals.id, id));
      });
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
    async replaceDraw(dealId: string, ref: string, draw: DealDraw) {
      const { ref: _r, ...rest } = draw;
      await db.update(commissionDealDraws).set(rest).where(sql`${commissionDealDraws.dealId} = ${dealId} and ${commissionDealDraws.ref} = ${ref}`);
    },
    async updateClawback(id: string, patch: Partial<Pick<Clawback, 'amount' | 'date' | 'reason'>>) {
      await db.update(commissionClawbacks).set(patch).where(eq(commissionClawbacks.id, id));
    },
    async deleteClawback(id: string) {
      await db.delete(commissionClawbacks).where(eq(commissionClawbacks.id, id));
    },
    async renameRef(kind: 'lender' | 'partner' | 'product', from: string, to: string) {
      const col = kind === 'lender' ? commissionDeals.lender : kind === 'product' ? commissionDeals.product : commissionDeals.referralPartner;
      const rows = await db.update(commissionDeals).set({ [kind === 'lender' ? 'lender' : kind === 'product' ? 'product' : 'referralPartner']: to, updatedAt: sql`now()` } as never).where(eq(col, from)).returning({ id: commissionDeals.id });
      return rows.length;
    },
    async deleteDraw(dealId: string, ref: string) {
      await db.delete(commissionDealDraws).where(sql`${commissionDealDraws.dealId} = ${dealId} and ${commissionDealDraws.ref} = ${ref}`);
    },
    async deleteRun(id: string) {
      await db.delete(commissionPayrollRuns).where(eq(commissionPayrollRuns.id, id));
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
    async createPasswordReset(r: PasswordReset) {
      await db.insert(commissionPasswordResets).values({ id: r.id, repId: r.repId, tokenHash: r.tokenHash, expiresAt: new Date(r.expiresAt), usedAt: r.usedAt ? new Date(r.usedAt) : null });
    },
    async findPasswordReset(tokenHash: string) {
      const rows = await db.select().from(commissionPasswordResets).where(eq(commissionPasswordResets.tokenHash, tokenHash)).limit(1);
      const r = rows[0];
      return r ? { id: r.id, repId: r.repId, tokenHash: r.tokenHash, expiresAt: r.expiresAt.toISOString(), usedAt: r.usedAt ? r.usedAt.toISOString() : null } : null;
    },
    async consumePasswordReset(id: string) {
      await db.update(commissionPasswordResets).set({ usedAt: sql`now()` }).where(eq(commissionPasswordResets.id, id));
    },
    async getTotp(repId: string): Promise<TotpState> {
      const rows = await db.select({ secret: commissionReps.totpSecret, enabled: commissionReps.totpEnabled }).from(commissionReps).where(eq(commissionReps.id, repId)).limit(1);
      return rows[0] ? { secret: rows[0].secret, enabled: rows[0].enabled } : { secret: null, enabled: false };
    },
    async setTotp(repId: string, state: TotpState) {
      await db.update(commissionReps).set({ totpSecret: state.secret, totpEnabled: !!state.secret && state.enabled, updatedAt: sql`now()` }).where(eq(commissionReps.id, repId));
    },
    async repsWithTotp() {
      const rows = await db.select({ id: commissionReps.id }).from(commissionReps).where(eq(commissionReps.totpEnabled, true));
      return rows.map((r) => r.id);
    },
    async listNotes(dealId: string): Promise<DealNote[]> {
      const rows = await db.select().from(commissionDealNotes).where(eq(commissionDealNotes.dealId, dealId)).orderBy(desc(commissionDealNotes.createdAt));
      return rows.map((n) => ({ id: n.id, dealId: n.dealId, authorRepId: n.authorRepId, body: n.body, createdAt: n.createdAt.toISOString() }));
    },
    async insertNote(n: DealNote) {
      await db.insert(commissionDealNotes).values({ id: n.id, dealId: n.dealId, authorRepId: n.authorRepId, body: n.body, createdAt: new Date(n.createdAt) });
    },
    async deleteNote(id: string) {
      await db.delete(commissionDealNotes).where(eq(commissionDealNotes.id, id));
    },
    async listFiles(dealId: string) {
      const rows = await db
        .select({ id: commissionDealFiles.id, dealId: commissionDealFiles.dealId, name: commissionDealFiles.name, mime: commissionDealFiles.mime, size: commissionDealFiles.size, uploadedBy: commissionDealFiles.uploadedBy, createdAt: commissionDealFiles.createdAt })
        .from(commissionDealFiles)
        .where(eq(commissionDealFiles.dealId, dealId))
        .orderBy(desc(commissionDealFiles.createdAt));
      return rows.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() }));
    },
    async getFile(id: string): Promise<DealFile | null> {
      const rows = await db.select().from(commissionDealFiles).where(eq(commissionDealFiles.id, id)).limit(1);
      const f = rows[0];
      return f ? { ...f, createdAt: f.createdAt.toISOString() } : null;
    },
    async insertFile(f: DealFile) {
      await db.insert(commissionDealFiles).values({ id: f.id, dealId: f.dealId, name: f.name, mime: f.mime, size: f.size, data: f.data, uploadedBy: f.uploadedBy, createdAt: new Date(f.createdAt) });
    },
    async deleteFile(id: string) {
      await db.delete(commissionDealFiles).where(eq(commissionDealFiles.id, id));
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
          await tx.insert(commissionPayoutLines).values({ key: l.key, dealId: l.dealId, segmentKey: l.segmentKey, role: l.role, repId: l.repId, amount: l.amount, runId: l.runId, clawbackId: l.clawbackId, paidAt: l.paidAt, voids: l.voids ?? null });
        }
        for (const u of c.clawbackUpdates) await tx.update(commissionClawbacks).set({ recovered: u.recovered, status: u.status }).where(eq(commissionClawbacks.id, u.id));
        for (const id of c.dealsFullyPaid) await tx.update(commissionDeals).set({ repPaid: c.paidAt, updatedAt: sql`now()` }).where(sql`${commissionDeals.id} = ${id} and ${commissionDeals.repPaid} is null`);
        for (const id of c.dealsUnstamped ?? []) await tx.update(commissionDeals).set({ repPaid: null, updatedAt: sql`now()` }).where(eq(commissionDeals.id, id));
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
    async listAudit(limit = 100, offset = 0) {
      const rows = await db.select().from(commissionAuditLog).orderBy(desc(commissionAuditLog.at)).limit(limit).offset(offset);
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
