import { and, desc, eq, sql } from 'drizzle-orm';
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
  commissionPlaybookFirings,
  commissionPlaybooks,
  commissionRepFiles,
  commissionReps,
  commissionTasks,
  commissionSettings,
  commissionTeams,
  commissionTrustedDevices,
  toClawback,
  toDeal,
  toPayoutLine,
  toRep,
  toTeam,
  type Database,
} from '@greystone/db';
import { NOTIFICATION_DEFAULTS, PERMISSION_DEFAULTS, PORTAL_DEFAULTS, SECURITY_DEFAULTS, TEMPLATE_DEFAULTS, type AuditEntry, type DealFile, type DealNote, type DealPatch, type PasswordReset, type PayoutCommit, type Playbook, type PlaybookFiring, type Repo, type RepFile, type RepTask, type Settings, type TotpState, type TrustedDevice } from './repo.js';
import type { PlaybookRule } from './services/playbook-rules.js';
import { requestMeta } from './auth/request-context.js';

export function dbRepo(db: Database): Repo {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const toTask = (t: typeof commissionTasks.$inferSelect): RepTask => ({ id: t.id, dealId: t.dealId, repId: t.repId, playbookId: t.playbookId, title: t.title, dueDate: t.dueDate, status: t.status as RepTask['status'], outcome: t.outcome as RepTask['outcome'], note: t.note, createdBy: t.createdBy, createdAt: t.createdAt.toISOString(), doneAt: iso(t.doneAt) });
  const toDevice = (d: typeof commissionTrustedDevices.$inferSelect): TrustedDevice => ({ id: d.id, repId: d.repId, tokenHash: d.tokenHash, label: d.label, ip: d.ip, createdAt: d.createdAt.toISOString(), lastUsedAt: d.lastUsedAt.toISOString(), expiresAt: d.expiresAt.toISOString() });
  return {
    async listTrustedDevices(repId) {
      const rows = await db.select().from(commissionTrustedDevices).where(eq(commissionTrustedDevices.repId, repId)).orderBy(desc(commissionTrustedDevices.lastUsedAt));
      return rows.map(toDevice);
    },
    async findTrustedDevice(tokenHash) {
      const rows = await db.select().from(commissionTrustedDevices).where(eq(commissionTrustedDevices.tokenHash, tokenHash)).limit(1);
      return rows[0] ? toDevice(rows[0]) : null;
    },
    async insertTrustedDevice(d) {
      await db.insert(commissionTrustedDevices).values({ id: d.id, repId: d.repId, tokenHash: d.tokenHash, label: d.label, ip: d.ip, createdAt: new Date(d.createdAt), lastUsedAt: new Date(d.lastUsedAt), expiresAt: new Date(d.expiresAt) });
    },
    async touchTrustedDevice(id, patch) {
      await db.update(commissionTrustedDevices).set({ lastUsedAt: new Date(patch.lastUsedAt), ip: patch.ip }).where(eq(commissionTrustedDevices.id, id));
    },
    async deleteTrustedDevice(id) {
      await db.delete(commissionTrustedDevices).where(eq(commissionTrustedDevices.id, id));
    },
    async deleteTrustedDevices(repId) {
      await db.delete(commissionTrustedDevices).where(eq(commissionTrustedDevices.repId, repId));
    },
    async listAllNotes() {
      const rows = await db.select().from(commissionDealNotes).orderBy(commissionDealNotes.createdAt);
      return rows.map((n) => ({ id: n.id, dealId: n.dealId, authorRepId: n.authorRepId, body: n.body, createdAt: n.createdAt.toISOString() }));
    },
    async listAllFiles() {
      const rows = await db.select().from(commissionDealFiles).orderBy(commissionDealFiles.createdAt);
      return rows.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() }));
    },
    async listAllRepFiles() {
      const rows = await db.select().from(commissionRepFiles).orderBy(commissionRepFiles.createdAt);
      return rows.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() }));
    },
    async getSessionCutoff(repId) {
      const rows = await db.select({ at: commissionReps.sessionCutoff }).from(commissionReps).where(eq(commissionReps.id, repId)).limit(1);
      return iso(rows[0]?.at);
    },
    async setSessionCutoff(repId, at) {
      await db.update(commissionReps).set({ sessionCutoff: new Date(at), updatedAt: sql`now()` }).where(eq(commissionReps.id, repId));
    },
    async getCalendarToken(repId) {
      const rows = await db.select({ t: commissionReps.calendarToken }).from(commissionReps).where(eq(commissionReps.id, repId)).limit(1);
      return rows[0]?.t ?? null;
    },
    async setCalendarToken(repId, token) {
      await db.update(commissionReps).set({ calendarToken: token, updatedAt: sql`now()` }).where(eq(commissionReps.id, repId));
    },
    async findRepByCalendarToken(token) {
      const rows = await db.select().from(commissionReps).where(eq(commissionReps.calendarToken, token)).limit(1);
      return rows[0] ? toRep(rows[0]) : null;
    },
    async listRepFiles(repId) {
      const rows = await db
        .select({ id: commissionRepFiles.id, repId: commissionRepFiles.repId, name: commissionRepFiles.name, mime: commissionRepFiles.mime, size: commissionRepFiles.size, uploadedBy: commissionRepFiles.uploadedBy, createdAt: commissionRepFiles.createdAt })
        .from(commissionRepFiles)
        .where(eq(commissionRepFiles.repId, repId))
        .orderBy(desc(commissionRepFiles.createdAt));
      return rows.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() }));
    },
    async getRepFile(id): Promise<RepFile | null> {
      const rows = await db.select().from(commissionRepFiles).where(eq(commissionRepFiles.id, id)).limit(1);
      const f = rows[0];
      return f ? { ...f, createdAt: f.createdAt.toISOString() } : null;
    },
    async insertRepFile(f) {
      await db.insert(commissionRepFiles).values({ id: f.id, repId: f.repId, name: f.name, mime: f.mime, size: f.size, data: f.data, uploadedBy: f.uploadedBy, createdAt: new Date(f.createdAt) });
    },
    async deleteRepFile(id) {
      await db.delete(commissionRepFiles).where(eq(commissionRepFiles.id, id));
    },
    async listPlaybooks(): Promise<Playbook[]> {
      const rows = await db.select().from(commissionPlaybooks).orderBy(commissionPlaybooks.createdAt);
      return rows.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, rule: p.rule as PlaybookRule, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString() }));
    },
    async insertPlaybook(p) {
      await db.insert(commissionPlaybooks).values({ id: p.id, name: p.name, enabled: p.enabled, rule: p.rule, createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt) });
    },
    async updatePlaybook(id, patch) {
      await db.update(commissionPlaybooks).set({ ...patch, updatedAt: sql`now()` }).where(eq(commissionPlaybooks.id, id));
    },
    async deletePlaybook(id) {
      await db.delete(commissionPlaybooks).where(eq(commissionPlaybooks.id, id));
    },
    async listFirings(opts = {}): Promise<PlaybookFiring[]> {
      const where = [opts.playbookId ? eq(commissionPlaybookFirings.playbookId, opts.playbookId) : undefined, opts.dealId ? eq(commissionPlaybookFirings.dealId, opts.dealId) : undefined].filter(Boolean);
      const q = db.select().from(commissionPlaybookFirings).orderBy(desc(commissionPlaybookFirings.firedAt)).limit(opts.limit ?? 500);
      const rows = where.length ? await q.where(and(...(where as never[]))) : await q;
      return rows.map((f) => ({ id: f.id, playbookId: f.playbookId, dealId: f.dealId, repId: f.repId, firedAt: f.firedAt.toISOString(), detail: (f.detail as Record<string, unknown> | null) ?? null }));
    },
    async insertFiring(f) {
      await db.insert(commissionPlaybookFirings).values({ id: f.id, playbookId: f.playbookId, dealId: f.dealId, repId: f.repId, firedAt: new Date(f.firedAt), detail: f.detail ?? null });
    },
    async listTasks(filter = {}) {
      const where = [filter.repId ? eq(commissionTasks.repId, filter.repId) : undefined, filter.dealId ? eq(commissionTasks.dealId, filter.dealId) : undefined, filter.status ? eq(commissionTasks.status, filter.status) : undefined].filter(Boolean);
      const q = db.select().from(commissionTasks).orderBy(commissionTasks.dueDate, commissionTasks.createdAt);
      const rows = where.length ? await q.where(and(...(where as never[]))) : await q;
      return rows.map(toTask);
    },
    async insertTask(t) {
      await db.insert(commissionTasks).values({ id: t.id, dealId: t.dealId, repId: t.repId, playbookId: t.playbookId, title: t.title, dueDate: t.dueDate, status: t.status, outcome: t.outcome, note: t.note, createdBy: t.createdBy, createdAt: new Date(t.createdAt), doneAt: t.doneAt ? new Date(t.doneAt) : null });
    },
    async updateTask(id, patch) {
      await db
        .update(commissionTasks)
        .set({ ...(patch.status ? { status: patch.status } : {}), ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}), ...(patch.title ? { title: patch.title } : {}), ...(patch.dueDate ? { dueDate: patch.dueDate } : {}), ...(patch.doneAt !== undefined ? { doneAt: patch.doneAt ? new Date(patch.doneAt) : null } : {}) })
        .where(eq(commissionTasks.id, id));
    },
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
        portal: { ...PORTAL_DEFAULTS, ...(map.portal ?? {}) },
        notifications: { ...NOTIFICATION_DEFAULTS, ...(map.notifications ?? {}) },
        security: { ...SECURITY_DEFAULTS, ...(map.security ?? {}) },
        templates: { ...TEMPLATE_DEFAULTS, ...(map.templates ?? {}) },
        permissions: { ...PERMISSION_DEFAULTS, ...(map.permissions ?? {}) },
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
      await db.insert(commissionReps).values({ id: rep.id, name: rep.name, email: rep.email, role: rep.role, teamId: rep.teamId, openerRate: rep.openerRate, closerRate: rep.closerRate, overrideRate: rep.overrideRate, active: rep.active, superAdmin: !!rep.superAdmin, perms: rep.perms ?? null });
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
        ip: entry.ip ?? requestMeta()?.ip ?? null,
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
        ip: r.ip,
      }));
    },
  };
}
