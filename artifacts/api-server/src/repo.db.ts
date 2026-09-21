import { and, desc, eq, sql } from 'drizzle-orm';
import { assertBalanced, cents, journalFingerprint, projectAccounting, type AccountingJournal, type Clawback, type Deal, type DealDraw, type LedgerContext, type PayrollRun, type Rep, type Team, type WeeklySchedule } from '@greystone/commission';
import {
  commissionAuditLog,
  commissionAccountingPeriods,
  commissionAccountingSourceChains,
  commissionJournalLines,
  commissionJournals,
  commissionReconciliationMatches,
  commissionReconciliations,
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
  commissionSheetsSyncOperations,
  commissionTeams,
  commissionTrustedDevices,
  commissionWalletAdjustments,
  toClawback,
  toDeal,
  toPayoutLine,
  toRep,
  toTeam,
  type Database,
} from '@greystone/db';
import { NOTIFICATION_DEFAULTS, PERMISSION_DEFAULTS, PORTAL_DEFAULTS, SECURITY_DEFAULTS, TEMPLATE_DEFAULTS, type AccountingPeriod, type AuditEntry, type ClawbackMutationContext, type DealFile, type DealNote, type DealPatch, type PasswordReset, type PayoutCommit, type Playbook, type PlaybookFiring, type Reconciliation, type Repo, type RepFile, type RepTask, type Settings, type StoredJournal, type TotpState, type TrustedDevice } from './repo.js';
import type { WalletAdjustment } from '@greystone/commission';
import type { PlaybookRule } from './services/playbook-rules.js';
import { requestMeta } from './auth/request-context.js';

let accountingSyncTail = Promise.resolve();
const toWalletAdjustment = (row: typeof commissionWalletAdjustments.$inferSelect): WalletAdjustment => ({ ...row, createdAt: row.createdAt.toISOString() });

async function serializeAccountingSync<T>(work: () => Promise<T>): Promise<T> {
  const previous = accountingSyncTail;
  let release!: () => void;
  accountingSyncTail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

export function dbRepo(db: Database): Repo {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const toTask = (t: typeof commissionTasks.$inferSelect): RepTask => ({ id: t.id, dealId: t.dealId, repId: t.repId, playbookId: t.playbookId, title: t.title, dueDate: t.dueDate, status: t.status as RepTask['status'], outcome: t.outcome as RepTask['outcome'], note: t.note, createdBy: t.createdBy, createdAt: t.createdAt.toISOString(), doneAt: iso(t.doneAt) });
  const toDevice = (d: typeof commissionTrustedDevices.$inferSelect): TrustedDevice => ({ id: d.id, repId: d.repId, tokenHash: d.tokenHash, label: d.label, ip: d.ip, createdAt: d.createdAt.toISOString(), lastUsedAt: d.lastUsedAt.toISOString(), expiresAt: d.expiresAt.toISOString() });
  return {
    async listJournals(filter = {}) {
      const where = [filter.from ? sql`${commissionJournals.date} >= ${filter.from}` : undefined, filter.to ? sql`${commissionJournals.date} <= ${filter.to}` : undefined, filter.sourceKey ? eq(commissionJournals.sourceKey, filter.sourceKey) : undefined].filter(Boolean);
      const rows = where.length ? await db.select().from(commissionJournals).where(and(...(where as never[]))).orderBy(commissionJournals.date, commissionJournals.sourceKey) : await db.select().from(commissionJournals).orderBy(commissionJournals.date, commissionJournals.sourceKey);
      const lines = await db.select().from(commissionJournalLines);
      return rows.map((j): StoredJournal => ({ id: j.id, sourceKey: j.sourceKey, sourceType: j.sourceType, date: j.date, memo: j.memo, fingerprint: j.fingerprint, metadata: j.metadata as Record<string, string | number | boolean | null> | undefined, logicalSourceKey: j.logicalSourceKey, sourceVersion: j.sourceVersion, reversalOf: j.reversalOf, correctionDate: j.correctionDate, postingStatus: j.postingStatus as StoredJournal['postingStatus'], sealedAt: iso(j.sealedAt), lines: lines.filter((l) => l.journalId === j.id && (!filter.accountCode || l.accountCode === filter.accountCode)).map((l) => ({ id: l.id, accountCode: l.accountCode as StoredJournal['lines'][number]['accountCode'], debit: l.debit, credit: l.credit, memo: l.memo ?? undefined, dealId: l.dealId, repId: l.repId })) })).filter((j) => !filter.accountCode || j.lines.length);
    },
    async insertJournals(entries: AccountingJournal[]) {
      let inserted = 0; let existing = 0;
      await db.transaction(async (tx) => {
        for (const entry of entries) {
          assertBalanced(entry);
          // An identical source replay is always safe, including after period
          // close. Check this before enforcing the closed-period write rule.
          const present = await tx.select({ id: commissionJournals.id }).from(commissionJournals).where(eq(commissionJournals.sourceKey, entry.sourceKey)).limit(1);
          if (present.length) { existing++; continue; }
          const closed = await tx.select({ id: commissionAccountingPeriods.id }).from(commissionAccountingPeriods).where(sql`${commissionAccountingPeriods.status} = 'closed' and ${entry.date} between ${commissionAccountingPeriods.start} and ${commissionAccountingPeriods.end}`).limit(1);
          if (closed.length) throw new Error(`Accounting period is closed for ${entry.date}`);
          const row = await tx.insert(commissionJournals).values({ sourceKey: entry.sourceKey, logicalSourceKey: entry.sourceKey, sourceVersion: 1, sourceType: entry.sourceType, date: entry.date, memo: entry.memo, fingerprint: entry.fingerprint, metadata: entry.metadata ?? null, postingStatus: 'posting', sealedAt: null }).onConflictDoNothing({ target: commissionJournals.sourceKey }).returning({ id: commissionJournals.id });
          if (!row[0]) { existing++; continue; }
          await tx.insert(commissionJournalLines).values(entry.lines.map((l) => ({ journalId: row[0]!.id, accountCode: l.accountCode, debit: l.debit, credit: l.credit, memo: l.memo ?? null, dealId: l.dealId ?? null, repId: l.repId ?? null })));
          await tx.execute(sql`select commission_seal_journal(${row[0]!.id})`);
          await tx.insert(commissionAccountingSourceChains).values({ logicalSourceKey: entry.sourceKey, sourceVersion: 1, effectiveJournalId: row[0]!.id, currentFingerprint: entry.fingerprint }).onConflictDoNothing();
          inserted++;
        }
      }); return { inserted, existing };
    },
    async syncAccounting(entries: AccountingJournal[] | null, detectedOn: string, closePeriod?: { id: string; actorRepId: string }): Promise<import('./repo.js').AccountingSyncResult & { projected?: number; assumedCollectionDates?: number }> {
      entries?.forEach(assertBalanced);
      return serializeAccountingSync(async () => {
      // A session lock is acquired before the repeatable-read transaction begins.
      // Using pg_advisory_xact_lock inside that transaction would establish its
      // MVCC snapshot before a wait and could therefore resurrect a stale view.
      const connection = await db.$client.reserve();
      let locked = false;
      try {
        await connection`select pg_advisory_lock(hashtext('commission_accounting_sync'))`;
        locked = true;
        for (let attempt = 0; ; attempt++) {
          try {
            // Keep the session lock on its reserved connection while Drizzle
            // uses its supported full-client transaction path. The transaction
            // begins only after serialization, so its repeatable-read snapshot
            // cannot predate a wait on another accounting sync.
            return await db.transaction(async (tx) => {
        const initialSyncRows = await tx.select({ key: commissionSettings.key }).from(commissionSettings).where(eq(commissionSettings.key, 'accounting.initialSyncCompleted')).limit(1);
        const initialSyncCompleted = initialSyncRows.length > 0;
        let projectionResult: ReturnType<typeof projectAccounting> | null = null;
        let syncEntries = entries;
        if (syncEntries === null) {
          // The operational snapshot is loaded only after serialization and all
          // reads use this transaction, so a delayed request cannot post stale facts.
          const [deals, draws, lines, clawbacks] = await Promise.all([
            tx.select().from(commissionDeals).where(sql`${commissionDeals.deletedAt} is null`).orderBy(desc(commissionDeals.date), desc(commissionDeals.id)),
            tx.select().from(commissionDealDraws),
            tx.select().from(commissionPayoutLines),
            tx.select().from(commissionClawbacks).where(sql`${commissionClawbacks.forgivenAt} is null`),
          ]);
          const adjustments = await tx.select().from(commissionWalletAdjustments);
          projectionResult = projectAccounting({ deals: deals.map((d) => toDeal(d, draws)), payoutLines: lines.map(toPayoutLine), clawbacks: clawbacks.map(toClawback), adjustments: adjustments.map(toWalletAdjustment) });
          syncEntries = projectionResult.journals;
          syncEntries.forEach(assertBalanced);
        }
        const periodRows = await tx.select().from(commissionAccountingPeriods).for('update');
        const correctionDate = (onOrAfter: string) => periodRows
          .filter((p) => p.status === 'open' && p.end >= onOrAfter)
          .map((p) => onOrAfter < p.start ? p.start : onOrAfter).sort()[0] ?? null;
        const chainRows = await tx.select().from(commissionAccountingSourceChains).for('update');
        const chains = new Map(chainRows.map((c) => [c.logicalSourceKey, { version: c.sourceVersion, effectiveId: c.effectiveJournalId, fingerprint: c.currentFingerprint }]));
        const journalRows = await tx.select().from(commissionJournals);
        const lineRows = await tx.select().from(commissionJournalLines);
        const effectiveJournal = (id: string | null) => {
          const j = id ? journalRows.find((x) => x.id === id) : undefined;
          if (!j) return undefined;
          return {
            ...j,
            metadata: j.metadata as Record<string, string | number | boolean | null> | undefined,
            lines: lineRows.filter((l) => l.journalId === j.id).map((l) => ({ id: l.id, accountCode: l.accountCode as AccountingJournal['lines'][number]['accountCode'], debit: l.debit, credit: l.credit, memo: l.memo ?? undefined, dealId: l.dealId, repId: l.repId })),
          };
        };
        const add = async (entry: AccountingJournal, logicalSourceKey: string, sourceVersion: number, extra: { reversalOf?: string; correctionDate?: string } = {}) => {
          const rows = await tx.insert(commissionJournals).values({
            sourceKey: entry.sourceKey, logicalSourceKey, sourceVersion, sourceType: entry.sourceType, date: entry.date,
            memo: entry.memo, fingerprint: entry.fingerprint, metadata: entry.metadata ?? null,
            reversalOf: extra.reversalOf ?? null, correctionDate: extra.correctionDate ?? null,
            detectedAt: extra.correctionDate ? sql`now()` : null, postingStatus: 'posting', sealedAt: null,
          }).returning({ id: commissionJournals.id });
          const id = rows[0]!.id;
          await tx.insert(commissionJournalLines).values(entry.lines.map((l) => ({ journalId: id, accountCode: l.accountCode, debit: l.debit, credit: l.credit, memo: l.memo ?? null, dealId: l.dealId ?? null, repId: l.repId ?? null })));
          await tx.execute(sql`select commission_seal_journal(${id})`);
          return id;
        };
        const result = { inserted: 0, existing: 0, corrected: 0, removed: 0, unresolved: [] as Array<{ logicalSourceKey: string; reason: string; effectiveSourceKey?: string }>, pendingProjection: 0 };
        const projected = new Map(syncEntries.map((j) => [j.sourceKey, j]));
        for (const entry of syncEntries) {
          const chain = chains.get(entry.sourceKey);
          if (!chain) {
            const closed = periodRows.some((p) => p.status === 'closed' && entry.date >= p.start && entry.date <= p.end);
            if (closed) { result.unresolved.push({ logicalSourceKey: entry.sourceKey, reason: `Accounting period is closed for ${entry.date}` }); continue; }
            const id = await add(entry, entry.sourceKey, 1);
            await tx.insert(commissionAccountingSourceChains).values({ logicalSourceKey: entry.sourceKey, sourceVersion: 1, effectiveJournalId: id, currentFingerprint: entry.fingerprint });
            chains.set(entry.sourceKey, { version: 1, effectiveId: id, fingerprint: entry.fingerprint });
            result.inserted++;
            continue;
          }
          if (chain.fingerprint === entry.fingerprint && chain.effectiveId) { result.existing++; continue; }
          const effective = effectiveJournal(chain.effectiveId);
          const from = [detectedOn, entry.date, effective?.date ?? ''].sort().at(-1)!;
          const date = correctionDate(from);
          if (!date) { result.unresolved.push({ logicalSourceKey: entry.sourceKey, reason: 'No permissible open accounting period', ...(effective ? { effectiveSourceKey: effective.sourceKey } : {}) }); continue; }
          const version = chain.version + 1;
          if (effective) {
            const base: Omit<AccountingJournal, 'fingerprint'> = {
              sourceKey: `${entry.sourceKey}:correction:v${version}:reversal`, sourceType: `${effective.sourceType}_reversal`, date,
              memo: `Correction reversal — ${effective.memo}`,
              lines: effective.lines.map(({ id: _id, ...l }) => ({ ...l, debit: l.credit, credit: l.debit })),
              metadata: { ...(effective.metadata ?? {}), correction: true, correctionDetectedOn: detectedOn, originalAccountingDate: effective.date },
            };
            await add({ ...base, fingerprint: journalFingerprint(base) }, entry.sourceKey, version, { reversalOf: effective.id, correctionDate: date });
          }
          const replacement: AccountingJournal = { ...entry, sourceKey: `${entry.sourceKey}:correction:v${version}:replacement`, date, metadata: { ...(entry.metadata ?? {}), correction: true, correctionDetectedOn: detectedOn, originalAccountingDate: entry.date } };
          const replacementId = await add(replacement, entry.sourceKey, version, { correctionDate: date });
          await tx.update(commissionAccountingSourceChains).set({ sourceVersion: version, effectiveJournalId: replacementId, currentFingerprint: entry.fingerprint, updatedAt: sql`now()` }).where(eq(commissionAccountingSourceChains.logicalSourceKey, entry.sourceKey));
          chains.set(entry.sourceKey, { version, effectiveId: replacementId, fingerprint: entry.fingerprint });
          result.corrected++;
        }
        for (const [logicalSourceKey, chain] of chains) {
          if (projected.has(logicalSourceKey) || !chain.effectiveId) continue;
          const effective = effectiveJournal(chain.effectiveId);
          if (!effective) continue;
          const date = correctionDate(detectedOn > effective.date ? detectedOn : effective.date);
          if (!date) { result.unresolved.push({ logicalSourceKey, reason: 'No permissible open accounting period', effectiveSourceKey: effective.sourceKey }); continue; }
          const version = chain.version + 1;
          const base: Omit<AccountingJournal, 'fingerprint'> = {
            sourceKey: `${logicalSourceKey}:correction:v${version}:removed`, sourceType: `${effective.sourceType}_reversal`, date,
            memo: `Removed-source reversal — ${effective.memo}`,
            lines: effective.lines.map(({ id: _id, ...l }) => ({ ...l, debit: l.credit, credit: l.debit })),
            metadata: { ...(effective.metadata ?? {}), correction: true, sourceRemoved: true, correctionDetectedOn: detectedOn, originalAccountingDate: effective.date },
          };
          await add({ ...base, fingerprint: journalFingerprint(base) }, logicalSourceKey, version, { reversalOf: effective.id, correctionDate: date });
          await tx.update(commissionAccountingSourceChains).set({ sourceVersion: version, effectiveJournalId: null, currentFingerprint: null, updatedAt: sql`now()` }).where(eq(commissionAccountingSourceChains.logicalSourceKey, logicalSourceKey));
          result.removed++;
        }
        result.pendingProjection = result.unresolved.length;
        if (closePeriod) {
          const target = periodRows.find((p) => p.id === closePeriod.id);
          if (!target) throw new Error('Accounting period not found');
          if (target.status !== 'open') throw new Error('Accounting period is not open');
          if (!initialSyncCompleted) throw new Error('Initial accounting sync must complete before period close');
          if (result.unresolved.length) throw new Error(`Period close blocked by ${result.unresolved.length} unresolved source posting(s): ${result.unresolved.map((x) => `${x.logicalSourceKey}: ${x.reason}`).join('; ')}`);
          const periodJournals = await tx.select({ id: commissionJournals.id }).from(commissionJournals).where(sql`${commissionJournals.date} between ${target.start} and ${target.end}`);
          const ids = new Set(periodJournals.map((j) => j.id));
          const periodLines = (await tx.select().from(commissionJournalLines)).filter((line) => ids.has(line.journalId));
          const debit = cents(periodLines.reduce((n, line) => n + line.debit, 0));
          const credit = cents(periodLines.reduce((n, line) => n + line.credit, 0));
          if (debit !== credit) throw new Error(`Period journal tie-out failed: debits ${debit.toFixed(2)} do not equal credits ${credit.toFixed(2)}`);
          await tx.update(commissionAccountingPeriods).set({ status: 'closed', closedAt: sql`now()`, closedBy: closePeriod.actorRepId }).where(and(eq(commissionAccountingPeriods.id, target.id), eq(commissionAccountingPeriods.status, 'open')));
          return { ok: true as const, periodId: target.id, checklist: { projected: syncEntries.length, inserted: result.inserted, existing: result.existing, corrected: result.corrected, removed: result.removed, unresolved: 0, journalCount: periodJournals.length, debit, credit, balanced: true as const } } as unknown as import('./repo.js').AccountingSyncResult;
        }
        if (!result.unresolved.length) {
          await tx.insert(commissionSettings).values({ key: 'accounting.initialSyncCompleted', value: true as never }).onConflictDoUpdate({ target: commissionSettings.key, set: { value: true as never, updatedAt: sql`now()` } });
        }
        return { ...result, ...(projectionResult ? { projected: projectionResult.journals.length, assumedCollectionDates: projectionResult.assumedCollectionDates.length } : {}) };
            }, { isolationLevel: 'repeatable read' });
          } catch (error) {
            const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
            if ((code === '40001' || code === '40P01') && attempt < 2) continue;
            throw error;
          }
        }
      } finally {
        try {
          if (locked) await connection`select pg_advisory_unlock(hashtext('commission_accounting_sync'))`;
        } finally {
          connection.release();
        }
      }
      });
    },
    async listAccountingPeriods() {
      const rows = await db.select().from(commissionAccountingPeriods).orderBy(commissionAccountingPeriods.start);
      return rows.map((p): AccountingPeriod => ({ id: p.id, start: p.start, end: p.end, status: p.status as AccountingPeriod['status'], closedAt: iso(p.closedAt), closedBy: p.closedBy, reopenedAt: iso(p.reopenedAt), reopenedBy: p.reopenedBy }));
    },
    async createAccountingPeriod(input) {
      const rows = await db.insert(commissionAccountingPeriods).values(input).returning();
      const p = rows[0]!; return { id: p.id, start: p.start, end: p.end, status: 'open', closedAt: null, closedBy: null, reopenedAt: null, reopenedBy: null };
    },
    async closeAccountingPeriod(id, actorRepId) {
      const self = this as Repo & { syncAccounting(journals: AccountingJournal[] | null, detectedOn: string, closePeriod: { id: string; actorRepId: string }): Promise<import('./repo.js').PeriodCloseResult> };
      return self.syncAccounting(null, new Date().toISOString().slice(0, 10), { id, actorRepId });
    },
    async reopenAccountingPeriod(id, actorRepId) { const r = await db.update(commissionAccountingPeriods).set({ status: 'open', reopenedAt: sql`now()`, reopenedBy: actorRepId }).where(and(eq(commissionAccountingPeriods.id, id), eq(commissionAccountingPeriods.status, 'closed'))).returning({ id: commissionAccountingPeriods.id }); if (!r.length) throw new Error(`Period not found or is not closed`); },
    async createReconciliation(input) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'reconciliation:' + input.accountCode}))`);
        const prior = await tx.select().from(commissionReconciliations).where(and(eq(commissionReconciliations.accountCode, input.accountCode), eq(commissionReconciliations.status, 'completed'))).orderBy(desc(commissionReconciliations.statementDate)).limit(1).for('update');
        if (prior[0] && (input.statementStart <= prior[0].statementDate || cents(input.openingBalance) !== cents(prior[0].statementBalance))) throw new Error('Statement must start after the prior completed statement and carry forward its closing balance');
        const rows = await tx.insert(commissionReconciliations).values({ accountCode: input.accountCode, statementStart: input.statementStart, statementDate: input.statementDate, openingBalance: cents(input.openingBalance), statementBalance: cents(input.statementBalance), status: input.status, note: input.note, createdBy: input.createdBy }).returning();
        const r = rows[0]!;
        return { id: r.id, accountCode: r.accountCode, statementStart: r.statementStart, statementDate: r.statementDate, openingBalance: r.openingBalance, statementBalance: r.statementBalance, status: r.status as Reconciliation['status'], note: r.note, createdBy: r.createdBy, matches: [] };
      });
    },
    async listReconciliations() {
      const [rows, matches] = await Promise.all([db.select().from(commissionReconciliations).orderBy(desc(commissionReconciliations.statementDate)), db.select().from(commissionReconciliationMatches)]);
      return rows.map((r): Reconciliation => ({ id: r.id, accountCode: r.accountCode, statementStart: r.statementStart, statementDate: r.statementDate, openingBalance: r.openingBalance, statementBalance: r.statementBalance, status: r.status as Reconciliation['status'], note: r.note, createdBy: r.createdBy, matches: matches.filter((m) => m.reconciliationId === r.id).map((m) => ({ journalLineId: m.journalLineId, amount: m.amount })) }));
    },
    async findReconciliation(id) { return (await (this as Repo).listReconciliations()).find((r) => r.id === id) ?? null; },
    async updateReconciliation(id, patch) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionReconciliations).where(eq(commissionReconciliations.id, id)).limit(1).for('update');
        const current = rows[0];
        if (!current) throw new Error(`No reconciliation ${id}`);
        const matches = await tx.select().from(commissionReconciliationMatches).where(eq(commissionReconciliationMatches.reconciliationId, id)).for('update');
        if (current.status !== 'open') throw new Error('Reconciliation is not open');
        if (patch.status && patch.status !== 'completed') throw new Error('Use the audited reopen endpoint to reopen a reconciliation');
        if (patch.status === 'completed') {
          const activity = cents(matches.reduce((total, match) => total + match.amount, 0));
          if (cents(current.openingBalance + activity - current.statementBalance) !== 0) throw new Error('Reconciliation difference must be exactly zero cents');
        }
        await tx.update(commissionReconciliations).set({ ...(patch.note !== undefined ? { note: patch.note } : {}), ...(patch.status ? { status: patch.status } : {}), updatedAt: sql`now()` }).where(eq(commissionReconciliations.id, id));
      });
    },
    async reopenReconciliation(id) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionReconciliations).where(eq(commissionReconciliations.id, id)).limit(1).for('update');
        if (!rows[0]) throw new Error(`No reconciliation ${id}`);
        await tx.select().from(commissionReconciliationMatches).where(eq(commissionReconciliationMatches.reconciliationId, id)).for('update');
        if (rows[0].status !== 'completed') throw new Error('Only completed reconciliations can be reopened');
        await tx.update(commissionReconciliations).set({ status: 'open', updatedAt: sql`now()` }).where(eq(commissionReconciliations.id, id));
      });
    },
    async matchReconciliation(id, match) {
      if (!Number.isFinite(match.amount) || match.amount === 0) throw new Error('Match amount must be nonzero');
      await db.transaction(async (tx) => {
        const r = await tx.select().from(commissionReconciliations).where(eq(commissionReconciliations.id, id)).limit(1).for('update');
        if (!r[0]) throw new Error(`No reconciliation ${id}`);
        if (r[0].status !== 'open') throw new Error('Reconciliation is not open');
        const rows = await tx.select({ line: commissionJournalLines, date: commissionJournals.date })
          .from(commissionJournalLines).innerJoin(commissionJournals, eq(commissionJournals.id, commissionJournalLines.journalId))
          .where(eq(commissionJournalLines.id, match.journalLineId)).limit(1).for('update');
        const found = rows[0];
        if (!found || found.line.accountCode !== r[0].accountCode || found.date > r[0].statementDate) throw new Error('Journal line does not belong to reconciliation account or statement cutoff');
        const used = await tx.select({ id: commissionReconciliationMatches.id }).from(commissionReconciliationMatches).where(eq(commissionReconciliationMatches.journalLineId, match.journalLineId)).limit(1).for('update');
        if (used.length) throw new Error('Journal line is already matched');
        const value = cents(found.line.debit - found.line.credit);
        const amount = cents(match.amount);
        if (amount !== value) throw new Error('Match amount must equal the full signed journal line amount');
        try {
          await tx.insert(commissionReconciliationMatches).values({ reconciliationId: id, journalLineId: match.journalLineId, amount });
        } catch (error) {
          if ((error as { code?: string }).code === '23505') throw new Error('Journal line is already matched');
          throw error;
        }
      });
    },
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
      const [deals, draws, lines, clawbacks, adjustments] = await Promise.all([
        db.select().from(commissionDeals).where(sql`${commissionDeals.deletedAt} is null`).orderBy(desc(commissionDeals.date), desc(commissionDeals.id)),
        db.select().from(commissionDealDraws),
        db.select().from(commissionPayoutLines),
        db.select().from(commissionClawbacks).where(sql`${commissionClawbacks.forgivenAt} is null`),
        db.select().from(commissionWalletAdjustments),
      ]);
      return { deals: deals.map((d) => toDeal(d, draws)), lines: lines.map(toPayoutLine), clawbacks: clawbacks.map(toClawback), adjustments: adjustments.map(toWalletAdjustment) };
    },
    async listWalletAdjustments() { return (await db.select().from(commissionWalletAdjustments)).map(toWalletAdjustment); },
    async createWalletAdjustment(a) {
      try {
        return await db.transaction(async (tx) => {
        const prior = await tx.select().from(commissionWalletAdjustments).where(eq(commissionWalletAdjustments.idempotencyKey, a.idempotencyKey)).limit(1);
        if (prior[0]) {
          const existing = toWalletAdjustment(prior[0]);
          if (existing.dealId !== a.dealId || existing.repId !== a.repId || existing.amount !== a.amount || existing.reason !== a.reason || existing.effectiveDate !== a.effectiveDate) throw new Error('idempotency key conflicts with an existing adjustment');
          return existing;
        }
        const rows = await tx.insert(commissionWalletAdjustments).values({ ...a, createdAt: new Date(a.createdAt) }).returning();
        return toWalletAdjustment(rows[0]!);
        });
      } catch (error) {
        // A concurrent request may win the unique idempotency insert after
        // both transactions read no prior row. Replay it if the payload agrees.
        const prior = await db.select().from(commissionWalletAdjustments).where(eq(commissionWalletAdjustments.idempotencyKey, a.idempotencyKey)).limit(1);
        if (prior[0]) {
          const existing = toWalletAdjustment(prior[0]);
          if (existing.dealId === a.dealId && existing.repId === a.repId && existing.amount === a.amount && existing.reason === a.reason && existing.effectiveDate === a.effectiveDate) return existing;
          throw new Error('idempotency key conflicts with an existing adjustment');
        }
        throw error;
      }
    },
    async reverseWalletAdjustment(id, reversal) {
      return db.transaction(async (tx) => {
        const original = await tx.select().from(commissionWalletAdjustments).where(eq(commissionWalletAdjustments.id, id)).for('update').limit(1);
        if (!original[0]) throw new Error('Adjustment not found');
        if (original[0].reversalOf) throw new Error('Cannot reverse a reversal');
        const sameKey = await tx.select().from(commissionWalletAdjustments).where(eq(commissionWalletAdjustments.idempotencyKey, reversal.idempotencyKey)).limit(1);
        if (sameKey[0]) {
          if (sameKey[0].reversalOf !== id || sameKey[0].dealId !== reversal.dealId || sameKey[0].repId !== reversal.repId || Number(sameKey[0].amount) !== reversal.amount) {
            throw new Error('idempotency key conflicts with an existing adjustment');
          }
          return toWalletAdjustment(sameKey[0]);
        }
        const prior = await tx.select().from(commissionWalletAdjustments).where(eq(commissionWalletAdjustments.reversalOf, id)).for('update').limit(1);
        if (prior[0]) {
          if (prior[0].idempotencyKey === reversal.idempotencyKey) return toWalletAdjustment(prior[0]);
          throw new Error('Adjustment has already been reversed');
        }
        if (reversal.amount !== -Number(original[0].amount)) throw new Error('Reversal must be exact opposite');
        const rows = await tx.insert(commissionWalletAdjustments).values({ ...reversal, createdAt: new Date(reversal.createdAt) }).returning();
        return toWalletAdjustment(rows[0]!);
      });
    },
    async getSetting<T>(key: string): Promise<T | null> {
      const rows = await db.select().from(commissionSettings).where(eq(commissionSettings.key, key)).limit(1);
      return rows[0] ? (rows[0].value as T) : null;
    },
    async claimSettingOnce(key: string, value: unknown = true): Promise<boolean> {
      const rows = await db.insert(commissionSettings)
        .values({ key, value: value as never })
        .onConflictDoNothing({ target: commissionSettings.key })
        .returning({ key: commissionSettings.key });
      return rows.length === 1;
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
      await db.insert(commissionClawbacks).values({ id: c.id, dealId: c.dealId, date: c.date, amount: c.amount, reason: c.reason, status: c.status, recovered: c.recovered, forgivenAt: c.forgivenAt ? new Date(c.forgivenAt) : null });
    },
    async deleteDeal(id: string, actorRepId?: string) {
      await db.update(commissionDeals)
        .set({ deletedAt: sql`now()`, deletedBy: actorRepId ?? null, updatedAt: sql`now()` })
        .where(sql`${commissionDeals.id} = ${id} and ${commissionDeals.deletedAt} is null`);
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
    async updateDealLocked(id, patch, validate) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionDeals).where(eq(commissionDeals.id, id)).for('update');
        if (!rows[0]) throw new Error(`No deal ${id}`);
        const draws = await tx.select().from(commissionDealDraws).where(eq(commissionDealDraws.dealId, id)).for('update');
        const lines = await tx.select().from(commissionPayoutLines).where(eq(commissionPayoutLines.dealId, id));
        const clawbacks = await tx.select().from(commissionClawbacks).where(eq(commissionClawbacks.dealId, id));
        validate(toDeal(rows[0], draws), lines.map(toPayoutLine), clawbacks.map(toClawback));
        await tx.update(commissionDeals).set({ ...patch, updatedAt: sql`now()` }).where(eq(commissionDeals.id, id));
      });
    },
    async insertDraw(dealId: string, draw: DealDraw) {
      await db.insert(commissionDealDraws).values({ dealId, ...draw });
    },
    async insertDrawLocked(dealId, build) {
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionDeals).where(eq(commissionDeals.id, dealId)).for('update');
        if (!rows[0]) throw new Error(`No deal ${dealId}`);
        const draws = await tx.select().from(commissionDealDraws).where(eq(commissionDealDraws.dealId, dealId)).for('update');
        const lines = await tx.select().from(commissionPayoutLines).where(eq(commissionPayoutLines.dealId, dealId));
        const clawbacks = await tx.select().from(commissionClawbacks).where(eq(commissionClawbacks.dealId, dealId));
        const draw = build(toDeal(rows[0], draws), lines.map(toPayoutLine), clawbacks.map(toClawback));
        await tx.insert(commissionDealDraws).values({ dealId, ...draw });
        return draw;
      });
    },
    async updateDraw(dealId: string, ref: string, patch: { collected: number | null; schedule: WeeklySchedule | null }) {
      await db.update(commissionDealDraws).set(patch).where(sql`${commissionDealDraws.dealId} = ${dealId} and ${commissionDealDraws.ref} = ${ref}`);
    },
    async updateSegmentLocked(dealId, segmentKey, build) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionDeals).where(eq(commissionDeals.id, dealId)).for('update');
        if (!rows[0]) throw new Error(`No deal ${dealId}`);
        const draws = await tx.select().from(commissionDealDraws).where(eq(commissionDealDraws.dealId, dealId)).for('update');
        const lines = await tx.select().from(commissionPayoutLines).where(eq(commissionPayoutLines.dealId, dealId));
        const clawbacks = await tx.select().from(commissionClawbacks).where(eq(commissionClawbacks.dealId, dealId));
        const patch = build(toDeal(rows[0], draws), lines.map(toPayoutLine), clawbacks.map(toClawback));
        if (segmentKey === 'base') {
          await tx.update(commissionDeals).set({ commCollected: patch.collected, commSchedule: patch.schedule, ...(patch.lenderPaid !== undefined ? { lenderPaid: patch.lenderPaid } : {}), updatedAt: sql`now()` }).where(eq(commissionDeals.id, dealId));
        } else {
          await tx.update(commissionDealDraws).set({ collected: patch.collected, schedule: patch.schedule }).where(and(eq(commissionDealDraws.dealId, dealId), eq(commissionDealDraws.ref, segmentKey)));
        }
      });
    },
    async replaceDraw(dealId: string, ref: string, draw: DealDraw) {
      const { ref: _r, ...rest } = draw;
      await db.update(commissionDealDraws).set(rest).where(sql`${commissionDealDraws.dealId} = ${dealId} and ${commissionDealDraws.ref} = ${ref}`);
    },
    async replaceDrawLocked(dealId, ref, build) {
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionDeals).where(eq(commissionDeals.id, dealId)).for('update');
        if (!rows[0]) throw new Error(`No deal ${dealId}`);
        const draws = await tx.select().from(commissionDealDraws).where(eq(commissionDealDraws.dealId, dealId)).for('update');
        const lines = await tx.select().from(commissionPayoutLines).where(eq(commissionPayoutLines.dealId, dealId));
        const clawbacks = await tx.select().from(commissionClawbacks).where(eq(commissionClawbacks.dealId, dealId));
        const draw = build(toDeal(rows[0], draws), lines.map(toPayoutLine), clawbacks.map(toClawback));
        const { ref: _ref, ...rest } = draw;
        await tx.update(commissionDealDraws).set(rest).where(sql`${commissionDealDraws.dealId} = ${dealId} and ${commissionDealDraws.ref} = ${ref}`);
        return draw;
      });
    },
    async deleteDrawLocked(dealId, ref, validate) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionDeals).where(eq(commissionDeals.id, dealId)).for('update');
        if (!rows[0]) throw new Error(`No deal ${dealId}`);
        const draws = await tx.select().from(commissionDealDraws).where(eq(commissionDealDraws.dealId, dealId)).for('update');
        const lines = await tx.select().from(commissionPayoutLines).where(eq(commissionPayoutLines.dealId, dealId));
        const clawbacks = await tx.select().from(commissionClawbacks).where(eq(commissionClawbacks.dealId, dealId));
        validate(toDeal(rows[0], draws.filter((draw) => draw.ref !== ref)), lines.map(toPayoutLine), clawbacks.map(toClawback));
        await tx.delete(commissionDealDraws).where(and(eq(commissionDealDraws.dealId, dealId), eq(commissionDealDraws.ref, ref)));
      });
    },
    async updateClawback(id: string, patch: Partial<Pick<Clawback, 'amount' | 'date' | 'reason'>>) {
      await db.update(commissionClawbacks).set(patch).where(eq(commissionClawbacks.id, id));
    },
    async updateClawbackLocked(dealId, id, patch, validate) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(commissionDeals).where(eq(commissionDeals.id, dealId)).for('update');
        if (!rows[0]) throw new Error(`No deal ${dealId}`);
        const draws = await tx.select().from(commissionDealDraws).where(eq(commissionDealDraws.dealId, dealId)).for('update');
        const clawbackRows = await tx.select().from(commissionClawbacks).where(eq(commissionClawbacks.id, id)).for('update');
        if (!clawbackRows[0]) throw new Error(`No clawback ${id}`);
        const lines = await tx.select().from(commissionPayoutLines).where(eq(commissionPayoutLines.dealId, dealId));
        validate(toDeal(rows[0], draws), toClawback(clawbackRows[0]), lines.map(toPayoutLine));
        await tx.update(commissionClawbacks).set(patch).where(eq(commissionClawbacks.id, id));
      });
    },
    async deleteClawback(id: string) {
      await db.update(commissionClawbacks).set({ forgivenAt: sql`now()` }).where(and(eq(commissionClawbacks.id, id), sql`${commissionClawbacks.forgivenAt} is null`));
    },
    async mutateClawback<T>(dealId: string, clawbackId: string | null, mutate: (context: ClawbackMutationContext) => import('./repo.js').ClawbackMutation<T> | Promise<import('./repo.js').ClawbackMutation<T>>): Promise<T> {
      return db.transaction(async (tx) => {
        // This is deliberately the same first lock as deal monetary edits and
        // payout commits (parent deal row; stable deal ordering is irrelevant
        // for this one-deal operation).
        const dealRows = await tx.select().from(commissionDeals).where(eq(commissionDeals.id, dealId)).for('update');
        if (!dealRows[0]) throw new Error(`No deal ${dealId}`);
        const draws = await tx.select().from(commissionDealDraws).where(eq(commissionDealDraws.dealId, dealId)).for('update');
        const clawbackRows = await tx.select().from(commissionClawbacks).where(eq(commissionClawbacks.dealId, dealId)).for('update');
        const lineRows = await tx.select().from(commissionPayoutLines).where(eq(commissionPayoutLines.dealId, dealId)).for('update');
        const clawbacks = clawbackRows.map(toClawback);
        const target = clawbackId === null ? null : clawbacks.find((c) => c.id === clawbackId) ?? null;
        if (clawbackId !== null && !target) throw new Error(`No clawback ${clawbackId} on deal ${dealId}`);
        const mutation = await mutate({
          deal: toDeal(dealRows[0], draws),
          clawback: target,
          activeClawbacks: clawbacks.filter((c) => !c.forgivenAt),
          lines: lineRows.map(toPayoutLine),
        });
        const writes = Number(!!mutation.create) + Number(!!mutation.update) + Number(!!mutation.forgive);
        if (writes > 1) throw new Error('A clawback mutation may create, update, or forgive, not multiple lifecycle writes');
        if (mutation.create) {
          if (clawbackId !== null || mutation.create.dealId !== dealId) throw new Error('Clawback create must use the locked deal and no target id');
          await tx.insert(commissionClawbacks).values({ id: mutation.create.id, dealId, date: mutation.create.date, amount: mutation.create.amount, reason: mutation.create.reason, status: mutation.create.status, recovered: mutation.create.recovered, forgivenAt: mutation.create.forgivenAt ? new Date(mutation.create.forgivenAt) : null });
        } else if (mutation.update) {
          if (!target) throw new Error('Clawback update requires a target');
          await tx.update(commissionClawbacks).set(mutation.update).where(eq(commissionClawbacks.id, target.id));
        } else if (mutation.forgive) {
          if (!target) throw new Error('Clawback forgive requires a target');
          await tx.update(commissionClawbacks).set({ forgivenAt: sql`now()` }).where(eq(commissionClawbacks.id, target.id));
        }
        return mutation.result;
      });
    },
    async renameRef(kind: 'lender' | 'partner' | 'product', from: string, to: string) {
      const col = kind === 'lender' ? commissionDeals.lender : kind === 'product' ? commissionDeals.product : commissionDeals.referralPartner;
      const rows = await db.update(commissionDeals).set({ [kind === 'lender' ? 'lender' : kind === 'product' ? 'product' : 'referralPartner']: to, updatedAt: sql`now()` } as never).where(and(eq(col, from), sql`${commissionDeals.deletedAt} is null`)).returning({ id: commissionDeals.id });
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
      await db.insert(commissionReps).values({ id: rep.id, name: rep.name, email: rep.email, role: rep.role, teamId: rep.teamId, openerRate: rep.openerRate, closerRate: rep.closerRate, overrideRate: rep.overrideRate, commissionEligible: rep.commissionEligible !== false, active: rep.active, superAdmin: !!rep.superAdmin, perms: rep.perms ?? null });
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
    async transitionRun(id, from, patch) {
      const rows = await db
        .update(runsTable)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.label ? { label: patch.label } : {}),
          ...(patch.approvedAt !== undefined ? { approvedAt: patch.approvedAt ? new Date(patch.approvedAt) : null } : {}),
          ...(patch.paidAt !== undefined ? { paidAt: patch.paidAt ? new Date(patch.paidAt) : null } : {}),
        })
        .where(and(eq(runsTable.id, id), sql`${runsTable.status} in (${sql.join(from.map((s) => sql`${s}`), sql`, `)})`))
        .returning({ id: runsTable.id });
      return rows.length === 1;
    },
    async commitPayout(c: PayoutCommit) {
      await db.transaction(async (tx) => {
        for (const repId of [...new Set(c.lines.map((line) => line.repId))].sort()) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'payroll-rep:' + repId}))`);
        }
        // Deal economics edits lock the same parent first. Lock every affected
        // deal in a stable order before ledger insertion to avoid deadlocks and
        // make payout-vs-edit serialization explicit.
        for (const id of [...new Set(c.lines.map((line) => line.dealId))].sort()) {
          await tx.select({ id: commissionDeals.id }).from(commissionDeals).where(eq(commissionDeals.id, id)).for('update');
        }
        for (const l of c.lines) {
          await tx.insert(commissionPayoutLines).values({ key: l.key, dealId: l.dealId, segmentKey: l.segmentKey, role: l.role, repId: l.repId, amount: l.amount, runId: l.runId, clawbackId: l.clawbackId, paidAt: l.paidAt, voids: l.voids ?? null });
        }
        for (const u of c.clawbackUpdates) await tx.update(commissionClawbacks).set({ recovered: u.recovered, status: u.status }).where(eq(commissionClawbacks.id, u.id));
        for (const id of c.dealsFullyPaid) await tx.update(commissionDeals).set({ repPaid: c.paidAt, updatedAt: sql`now()` }).where(sql`${commissionDeals.id} = ${id} and ${commissionDeals.repPaid} is null`);
        for (const id of c.dealsUnstamped ?? []) await tx.update(commissionDeals).set({ repPaid: null, updatedAt: sql`now()` }).where(eq(commissionDeals.id, id));
      });
    },
    async commitPayoutForOpenRun(runId, c, validateDeals) {
      return db.transaction(async (tx) => {
        // A no-op conditional update locks this run until its ledger writes
        // finish. Archive uses its own conditional update, so either archive
        // wins and no rows are added, or payout wins before archival.
        const claimed = await tx
          .update(runsTable)
          .set({ status: sql`${runsTable.status}` })
          .where(and(eq(runsTable.id, runId), sql`${runsTable.status} in ('draft', 'approved')`))
          .returning({ id: runsTable.id });
        if (claimed.length !== 1) return false;
        for (const repId of [...new Set(c.lines.map((line) => line.repId))].sort()) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'payroll-rep:' + repId}))`);
        }
        const currentDeals: Deal[] = [];
        for (const id of [...new Set(c.lines.map((line) => line.dealId))].sort()) {
          const rows = await tx.select().from(commissionDeals).where(eq(commissionDeals.id, id)).for('update');
          if (!rows[0]) return false;
          const draws = await tx.select().from(commissionDealDraws).where(eq(commissionDealDraws.dealId, id)).for('update');
          currentDeals.push(toDeal(rows[0], draws));
        }
        // The payout was planned before this transaction. Re-check the exact
        // deal economics after taking the same locks used by monetary edits.
        if (validateDeals && !validateDeals(currentDeals)) return false;
        for (const l of c.lines) {
          await tx.insert(commissionPayoutLines).values({ key: l.key, dealId: l.dealId, segmentKey: l.segmentKey, role: l.role, repId: l.repId, amount: l.amount, runId: l.runId, clawbackId: l.clawbackId, paidAt: l.paidAt, voids: l.voids ?? null });
        }
        for (const u of c.clawbackUpdates) await tx.update(commissionClawbacks).set({ recovered: u.recovered, status: u.status }).where(eq(commissionClawbacks.id, u.id));
        for (const id of c.dealsFullyPaid) await tx.update(commissionDeals).set({ repPaid: c.paidAt, updatedAt: sql`now()` }).where(sql`${commissionDeals.id} = ${id} and ${commissionDeals.repPaid} is null`);
        for (const id of c.dealsUnstamped ?? []) await tx.update(commissionDeals).set({ repPaid: null, updatedAt: sql`now()` }).where(eq(commissionDeals.id, id));
        return true;
      });
    },
    async commitPayoutForUnarchivedRun(runId, c) {
      return db.transaction(async (tx) => {
        // This conditional update takes the same row lock used by archive.
        // Paid runs remain eligible for append-only Void corrections.
        const claimed = await tx
          .update(runsTable)
          .set({ status: sql`${runsTable.status}` })
          .where(and(eq(runsTable.id, runId), sql`${runsTable.status} <> 'archived'`))
          .returning({ id: runsTable.id });
        if (claimed.length !== 1) return false;
        for (const repId of [...new Set(c.lines.map((line) => line.repId))].sort()) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'payroll-rep:' + repId}))`);
        }
        for (const l of c.lines) {
          await tx.insert(commissionPayoutLines).values({ key: l.key, dealId: l.dealId, segmentKey: l.segmentKey, role: l.role, repId: l.repId, amount: l.amount, runId: l.runId, clawbackId: l.clawbackId, paidAt: l.paidAt, voids: l.voids ?? null });
        }
        for (const u of c.clawbackUpdates) await tx.update(commissionClawbacks).set({ recovered: u.recovered, status: u.status }).where(eq(commissionClawbacks.id, u.id));
        for (const id of c.dealsFullyPaid) await tx.update(commissionDeals).set({ repPaid: c.paidAt, updatedAt: sql`now()` }).where(sql`${commissionDeals.id} = ${id} and ${commissionDeals.repPaid} is null`);
        for (const id of c.dealsUnstamped ?? []) await tx.update(commissionDeals).set({ repPaid: null, updatedAt: sql`now()` }).where(eq(commissionDeals.id, id));
        return true;
      });
    },
    async planPayoutForRun<T>(runId: string, repId: string, allowed: Array<'draft' | 'approved' | 'paid'>, plan: (context: LedgerContext) => { commit: PayoutCommit; result: T }): Promise<T | null> {
      return db.transaction(async (tx) => {
        // Global lock order for payroll is run, rep, then deals. Deal mutation
        // paths only take the final lock, so they cannot form a lock cycle.
        const claimed = await tx
          .update(runsTable)
          .set({ status: sql`${runsTable.status}` })
          .where(and(
            eq(runsTable.id, runId),
            sql`${runsTable.status} in (${sql.join(allowed.map((s) => sql`${s}`), sql`, `)})`,
          ))
          .returning({ id: runsTable.id });
        if (claimed.length !== 1) return null;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'payroll-rep:' + repId}))`);

        // Reload every monetary dependency only after serialization. Deal and
        // draw locks also serialize against economics edits; ledger/clawback
        // locks protect positive, recovery, and void facts through insertion.
        const dealRows = await tx.select().from(commissionDeals)
          .where(sql`${commissionDeals.deletedAt} is null`)
          .orderBy(commissionDeals.id)
          .for('update');
        const draws = await tx.select().from(commissionDealDraws).for('update');
        const lineRows = await tx.select().from(commissionPayoutLines).for('update');
        const clawbackRows = await tx.select().from(commissionClawbacks)
          .where(sql`${commissionClawbacks.forgivenAt} is null`)
          .for('update');
        const context: LedgerContext = {
          deals: dealRows.map((deal) => toDeal(deal, draws)),
          lines: lineRows.map(toPayoutLine),
          clawbacks: clawbackRows.map(toClawback),
        };
        const planned = plan(context);
        const c = planned.commit;
        for (const l of c.lines) {
          await tx.insert(commissionPayoutLines).values({ key: l.key, dealId: l.dealId, segmentKey: l.segmentKey, role: l.role, repId: l.repId, amount: l.amount, runId: l.runId, clawbackId: l.clawbackId, paidAt: l.paidAt, voids: l.voids ?? null });
        }
        for (const u of c.clawbackUpdates) await tx.update(commissionClawbacks).set({ recovered: u.recovered, status: u.status }).where(eq(commissionClawbacks.id, u.id));
        for (const id of c.dealsFullyPaid) await tx.update(commissionDeals).set({ repPaid: c.paidAt, updatedAt: sql`now()` }).where(sql`${commissionDeals.id} = ${id} and ${commissionDeals.repPaid} is null`);
        for (const id of c.dealsUnstamped ?? []) await tx.update(commissionDeals).set({ repPaid: null, updatedAt: sql`now()` }).where(eq(commissionDeals.id, id));
        return planned.result;
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
    async getSyncIdempotency(operation, key) {
      const rows = await db.select().from(commissionSheetsSyncOperations).where(and(eq(commissionSheetsSyncOperations.operation, operation), eq(commissionSheetsSyncOperations.key, key))).limit(1);
      const row = rows[0];
      return row ? { operation: row.operation, key: row.key, payloadHash: row.payloadHash, state: row.state as 'processing' | 'completed' | 'failed', status: row.status, response: row.response } : null;
    },
    async putSyncIdempotency(record) {
      await db.insert(commissionSheetsSyncOperations).values({ operation: record.operation, key: record.key, payloadHash: record.payloadHash, status: record.status, response: record.response }).onConflictDoNothing({ target: [commissionSheetsSyncOperations.operation, commissionSheetsSyncOperations.key] });
    },
    async runSyncIdempotent<T>(operation: string, key: string, payloadHash: string, work: () => Promise<{ status: number; response: T }>) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'sheets-sync:' + operation + ':' + key}))`);
        const prior = await tx.select().from(commissionSheetsSyncOperations).where(and(eq(commissionSheetsSyncOperations.operation, operation), eq(commissionSheetsSyncOperations.key, key))).limit(1);
        if (prior[0]) {
          if (prior[0].payloadHash !== payloadHash) throw new Error('Idempotency key was used with a different payload');
          return { status: prior[0].status ?? 500, response: prior[0].response as T, replayed: true };
        }
        const result = await work();
        await tx.insert(commissionSheetsSyncOperations).values({ operation, key, payloadHash, status: result.status, response: result.response });
        return { ...result, replayed: false };
      });
    },
    async runSyncAtMostOnce<T>(operation: string, key: string, payloadHash: string, work: () => Promise<{ status: number; response: T }>) {
      const claimed = await db.insert(commissionSheetsSyncOperations)
        .values({ operation, key, payloadHash, state: 'processing', status: null, response: null })
        .onConflictDoNothing({ target: [commissionSheetsSyncOperations.operation, commissionSheetsSyncOperations.key] })
        .returning({ operation: commissionSheetsSyncOperations.operation });
      if (!claimed.length) {
        const rows = await db.select().from(commissionSheetsSyncOperations).where(and(eq(commissionSheetsSyncOperations.operation, operation), eq(commissionSheetsSyncOperations.key, key))).limit(1);
        const prior = rows[0]!;
        if (prior.payloadHash !== payloadHash) throw new Error('Idempotency key was used with a different payload');
        if (prior.state === 'processing') throw new Error('Sync operation is processing or uncertain; reconcile before retrying');
        return { status: prior.status ?? 500, response: prior.response as T, replayed: true };
      }
      try {
        const result = await work();
        await db.update(commissionSheetsSyncOperations).set({ state: 'completed', status: result.status, response: result.response }).where(and(eq(commissionSheetsSyncOperations.operation, operation), eq(commissionSheetsSyncOperations.key, key)));
        return { ...result, replayed: false };
      } catch (error) {
        const response = { error: error instanceof Error ? error.message : 'Sync operation failed' };
        await db.update(commissionSheetsSyncOperations).set({ state: 'failed', status: 500, response }).where(and(eq(commissionSheetsSyncOperations.operation, operation), eq(commissionSheetsSyncOperations.key, key)));
        throw error;
      }
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
