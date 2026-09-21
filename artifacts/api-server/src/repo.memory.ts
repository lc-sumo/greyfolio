import { assertBalanced, cents, journalFingerprint, projectAccounting, type AccountingJournal, type Clawback, type Deal, type DealDraw, type LedgerContext, type PayoutLine, type PayrollRun, type Rep, type Team, type WeeklySchedule, type WalletAdjustment } from '@greystone/commission';
import { NOTIFICATION_DEFAULTS, PERMISSION_DEFAULTS, PORTAL_DEFAULTS, SECURITY_DEFAULTS, TEMPLATE_DEFAULTS, type AccountingPeriod, type AuditEntry, type ClawbackMutationContext, type DealFile, type DealNote, type DealPatch, type PasswordReset, type PayoutCommit, type Playbook, type PlaybookFiring, type Reconciliation, type Repo, type RepFile, type RepTask, type Settings, type StoredJournal, type SyncIdempotencyRecord, type TotpState, type TrustedDevice } from './repo.js';
import { requestMeta } from './auth/request-context.js';

export interface MemoryData {
  reps: Rep[];
  teams: Team[];
  runs: PayrollRun[];
  deals: Deal[];
  lines: PayoutLine[];
  clawbacks: Clawback[];
  adjustments?: WalletAdjustment[];
  settings: Omit<Settings, 'portal' | 'notifications' | 'security' | 'templates' | 'permissions'> & Partial<Pick<Settings, 'portal' | 'notifications' | 'security' | 'templates' | 'permissions'>>;
}

/** In-memory Repo over plain arrays. Mutates the arrays it is given. */
export function memoryRepo(data: MemoryData): Repo & { audit: AuditEntry[]; data: MemoryData } {
  // SQL reads nullable timestamps as null; normalize legacy fixtures which
  // predate this additive column to that same active representation.
  for (const clawback of data.clawbacks) clawback.forgivenAt ??= null;
  const audit: AuditEntry[] = [];
  const ctx: LedgerContext = data;
  const passwords = new Map<string, string>();
  const resets: PasswordReset[] = [];
  const totp = new Map<string, TotpState>();
  const notes: DealNote[] = [];
  const files: DealFile[] = [];
  const repFiles: RepFile[] = [];
  const cutoffs = new Map<string, string>();
  const calendarTokens = new Map<string, string>();
  const playbooks: Playbook[] = [];
  const firings: PlaybookFiring[] = [];
  const tasks: RepTask[] = [];
  const devices: TrustedDevice[] = [];
  const journals: StoredJournal[] = [];
  const periods: AccountingPeriod[] = [];
  const reconciliations: Reconciliation[] = [];
  const chains = new Map<string, { version: number; effectiveId: string | null; fingerprint: string | null }>();
  const syncIdempotency = new Map<string, SyncIdempotencyRecord>();
  const syncQueues = new Map<string, Promise<void>>();
  let bookId = 0;
  let initialAccountingSyncCompleted = false;
  let accountingQueue: Promise<void> = Promise.resolve();
  const payoutQueues = new Map<string, Promise<void>>();
  const dealQueues = new Map<string, Promise<void>>();
  async function serializeDeal<T>(dealId: string, work: () => T | Promise<T>): Promise<T> {
    const previous = dealQueues.get(dealId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    dealQueues.set(dealId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (dealQueues.get(dealId) === tail) dealQueues.delete(dealId);
    }
  }
  async function serializePayout<T>(repId: string, work: () => T | Promise<T>): Promise<T> {
    const previous = payoutQueues.get(repId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    payoutQueues.set(repId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (payoutQueues.get(repId) === tail) payoutQueues.delete(repId);
    }
  }
  async function serializePayouts<T>(repIds: string[], work: () => T | Promise<T>): Promise<T> {
    const ordered = [...new Set(repIds)].sort();
    const acquire = (index: number): Promise<T> => index === ordered.length
      ? Promise.resolve(work())
      : serializePayout(ordered[index]!, () => acquire(index + 1));
    return acquire(0);
  }
  const stored = (entry: AccountingJournal, extra?: Partial<StoredJournal>): StoredJournal => ({
    ...entry,
    id: `journal-${++bookId}`,
    logicalSourceKey: entry.sourceKey,
    sourceVersion: 1,
    reversalOf: null,
    correctionDate: null,
    postingStatus: 'sealed',
    sealedAt: new Date().toISOString(),
    ...extra,
    lines: entry.lines.map((l) => ({ ...l, id: `journal-line-${++bookId}` })),
  });
  const correctionDate = (onOrAfter: string) => {
    const candidates = periods.filter((p) => p.status === 'open' && p.end >= onOrAfter).map((p) => onOrAfter < p.start ? p.start : onOrAfter).sort();
    return candidates[0] ?? null;
  };
  return {
    async listJournals(filter = {}) {
      return journals.filter((j) => (!filter.from || j.date >= filter.from) && (!filter.to || j.date <= filter.to) && (!filter.sourceKey || j.sourceKey === filter.sourceKey) && (!filter.accountCode || j.lines.some((l) => l.accountCode === filter.accountCode))).map((j) => ({ ...j, lines: [...j.lines] }));
    },
    async insertJournals(entries: AccountingJournal[]) {
      let inserted = 0; let existing = 0;
      for (const entry of entries) {
        assertBalanced(entry);
        if (journals.some((j) => j.sourceKey === entry.sourceKey)) { existing++; continue; }
        if (periods.some((p) => p.status === 'closed' && entry.date >= p.start && entry.date <= p.end)) throw new Error(`Accounting period is closed for ${entry.date}`);
        const row = stored(entry);
        journals.push(row);
        if (!chains.has(entry.sourceKey)) chains.set(entry.sourceKey, { version: 1, effectiveId: row.id, fingerprint: entry.fingerprint });
        inserted++;
      }
      return { inserted, existing };
    },
    async syncAccounting(entries, detectedOn) {
      let release!: () => void;
      const previous = accountingQueue;
      accountingQueue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        let projectionResult: ReturnType<typeof projectAccounting> | null = null;
        if (entries === null) {
          projectionResult = projectAccounting({ deals: data.deals, payoutLines: data.lines, clawbacks: data.clawbacks.filter((clawback) => !clawback.forgivenAt), adjustments: data.adjustments ?? [] });
          entries = projectionResult.journals;
        }
        entries.forEach(assertBalanced);
        const result = { inserted: 0, existing: 0, corrected: 0, removed: 0, unresolved: [] as Array<{ logicalSourceKey: string; reason: string; effectiveSourceKey?: string }>, pendingProjection: 0 };
        const projected = new Map(entries.map((j) => [j.sourceKey, j]));
        for (const entry of entries) {
          let chain = chains.get(entry.sourceKey);
          if (!chain) {
            const old = journals.find((j) => j.logicalSourceKey === entry.sourceKey || j.sourceKey === entry.sourceKey);
            if (old) {
              chain = { version: old.sourceVersion, effectiveId: old.id, fingerprint: old.fingerprint };
              chains.set(entry.sourceKey, chain);
            }
          }
          if (!chain) {
            if (periods.some((p) => p.status === 'closed' && entry.date >= p.start && entry.date <= p.end)) {
              result.unresolved.push({ logicalSourceKey: entry.sourceKey, reason: `Accounting period is closed for ${entry.date}` });
              continue;
            }
            const row = stored(entry);
            journals.push(row);
            chains.set(entry.sourceKey, { version: 1, effectiveId: row.id, fingerprint: entry.fingerprint });
            result.inserted++;
            continue;
          }
          if (chain.fingerprint === entry.fingerprint && chain.effectiveId) { result.existing++; continue; }
          const effective = chain.effectiveId ? journals.find((j) => j.id === chain!.effectiveId) : undefined;
          const date = correctionDate([detectedOn, entry.date, effective?.date ?? ''].sort().at(-1)!);
          if (!date) {
            result.unresolved.push({ logicalSourceKey: entry.sourceKey, reason: 'No permissible open accounting period', ...(effective ? { effectiveSourceKey: effective.sourceKey } : {}) });
            continue;
          }
          const version = chain.version + 1;
          if (effective) {
            const reversalBase: Omit<AccountingJournal, 'fingerprint'> = {
              sourceKey: `${entry.sourceKey}:correction:v${version}:reversal`, sourceType: `${effective.sourceType}_reversal`, date,
              memo: `Correction reversal — ${effective.memo}`,
              lines: effective.lines.map(({ id: _id, ...l }) => ({ ...l, debit: l.credit, credit: l.debit })),
              metadata: { ...(effective.metadata ?? {}), correction: true, correctionDetectedOn: detectedOn, originalAccountingDate: effective.date },
            };
            journals.push(stored({ ...reversalBase, fingerprint: journalFingerprint(reversalBase) }, { logicalSourceKey: entry.sourceKey, sourceVersion: version, reversalOf: effective.id, correctionDate: date }));
          }
          const replacement: AccountingJournal = {
            ...entry, sourceKey: `${entry.sourceKey}:correction:v${version}:replacement`, date,
            metadata: { ...(entry.metadata ?? {}), correction: true, correctionDetectedOn: detectedOn, originalAccountingDate: entry.date },
          };
          const replacementRow = stored(replacement, { logicalSourceKey: entry.sourceKey, sourceVersion: version, correctionDate: date });
          journals.push(replacementRow);
          chains.set(entry.sourceKey, { version, effectiveId: replacementRow.id, fingerprint: entry.fingerprint });
          result.corrected++;
        }
        for (const [logicalSourceKey, chain] of chains) {
          if (projected.has(logicalSourceKey) || !chain.effectiveId) continue;
          const effective = journals.find((j) => j.id === chain.effectiveId);
          if (!effective) continue;
          const date = correctionDate(detectedOn > effective.date ? detectedOn : effective.date);
          if (!date) {
            result.unresolved.push({ logicalSourceKey, reason: 'No permissible open accounting period', effectiveSourceKey: effective.sourceKey });
            continue;
          }
          const version = chain.version + 1;
          const reversalBase: Omit<AccountingJournal, 'fingerprint'> = {
            sourceKey: `${logicalSourceKey}:correction:v${version}:removed`, sourceType: `${effective.sourceType}_reversal`, date,
            memo: `Removed-source reversal — ${effective.memo}`,
            lines: effective.lines.map(({ id: _id, ...l }) => ({ ...l, debit: l.credit, credit: l.debit })),
            metadata: { ...(effective.metadata ?? {}), correction: true, sourceRemoved: true, correctionDetectedOn: detectedOn, originalAccountingDate: effective.date },
          };
          journals.push(stored({ ...reversalBase, fingerprint: journalFingerprint(reversalBase) }, { logicalSourceKey, sourceVersion: version, reversalOf: effective.id, correctionDate: date }));
          chains.set(logicalSourceKey, { version, effectiveId: null, fingerprint: null });
          result.removed++;
        }
        result.pendingProjection = result.unresolved.length;
        if (!result.unresolved.length) initialAccountingSyncCompleted = true;
        return { ...result, ...(projectionResult ? { projected: projectionResult.journals.length, assumedCollectionDates: projectionResult.assumedCollectionDates.length } : {}) };
      } finally {
        release();
      }
    },
    async listAccountingPeriods() { return periods.map((p) => ({ ...p })).sort((a, b) => a.start.localeCompare(b.start)); },
    async createAccountingPeriod(input) {
      if (periods.some((p) => input.start <= p.end && input.end >= p.start)) throw new Error('Accounting periods may not overlap');
      const p: AccountingPeriod = { id: `period-${++bookId}`, ...input, status: 'open', closedAt: null, closedBy: null, reopenedAt: null, reopenedBy: null }; periods.push(p); return { ...p };
    },
    async closeAccountingPeriod(id, actorRepId) {
      const p = periods.find((x) => x.id === id);
      if (!p) throw new Error(`No accounting period ${id}`);
      if (p.status !== 'open') throw new Error('Only open accounting periods can be closed');
      if (!initialAccountingSyncCompleted) throw new Error('Initial accounting sync must complete before period close');
      const result = await (this as Repo).syncAccounting(null, new Date().toISOString().slice(0, 10));
      if (result.unresolved.length) throw new Error(`Period close blocked by ${result.unresolved.length} unresolved source posting(s): ${result.unresolved.map((x) => `${x.logicalSourceKey}: ${x.reason}`).join('; ')}`);
      const inPeriod = journals.filter((j) => j.date >= p.start && j.date <= p.end);
      const debit = cents(inPeriod.flatMap((j) => j.lines).reduce((n, line) => n + line.debit, 0));
      const credit = cents(inPeriod.flatMap((j) => j.lines).reduce((n, line) => n + line.credit, 0));
      if (debit !== credit) throw new Error(`Period journal tie-out failed: debits ${debit.toFixed(2)} do not equal credits ${credit.toFixed(2)}`);
      p.status = 'closed'; p.closedAt = new Date().toISOString(); p.closedBy = actorRepId;
      return { ok: true, periodId: id, checklist: { projected: result.projected ?? 0, inserted: result.inserted, existing: result.existing, corrected: result.corrected, removed: result.removed, unresolved: 0, journalCount: inPeriod.length, debit, credit, balanced: true } };
    },
    async reopenAccountingPeriod(id, actorRepId) { const p = periods.find((x) => x.id === id); if (!p) throw new Error(`No accounting period ${id}`); if (p.status !== 'closed') throw new Error('Only closed accounting periods can be reopened'); p.status = 'open'; p.reopenedAt = new Date().toISOString(); p.reopenedBy = actorRepId; },
    async createReconciliation(input) {
      const prior = reconciliations.filter((x) => x.accountCode === input.accountCode && x.status === 'completed').sort((a, b) => b.statementDate.localeCompare(a.statementDate))[0];
      if (prior && (input.statementStart <= prior.statementDate || cents(input.openingBalance) !== cents(prior.statementBalance))) throw new Error('Statement must start after the prior completed statement and carry forward its closing balance');
      const r: Reconciliation = { ...input, openingBalance: cents(input.openingBalance), statementBalance: cents(input.statementBalance), id: `reconciliation-${++bookId}`, matches: [] };
      reconciliations.push(r);
      return { ...r, matches: [] };
    },
    async listReconciliations() { return reconciliations.map((r) => ({ ...r, matches: [...r.matches] })); },
    async findReconciliation(id) { const r = reconciliations.find((x) => x.id === id); return r ? { ...r, matches: [...r.matches] } : null; },
    async updateReconciliation(id, patch) {
      const r = reconciliations.find((x) => x.id === id);
      if (!r) throw new Error(`No reconciliation ${id}`);
      if (r.status !== 'open') throw new Error('Reconciliation is not open');
      if (patch.status && patch.status !== 'completed') throw new Error('Use the audited reopen endpoint to reopen a reconciliation');
      if (patch.status === 'completed' && cents(r.openingBalance + r.matches.reduce((n, m) => n + m.amount, 0) - r.statementBalance) !== 0) throw new Error('Reconciliation difference must be exactly zero cents');
      if (patch.note !== undefined) r.note = patch.note;
      if (patch.status !== undefined) r.status = patch.status;
    },
    async reopenReconciliation(id) {
      const r = reconciliations.find((x) => x.id === id);
      if (!r) throw new Error(`No reconciliation ${id}`);
      if (r.status !== 'completed') throw new Error('Only completed reconciliations can be reopened');
      r.status = 'open';
    },
    async matchReconciliation(id, match) {
      const r = reconciliations.find((x) => x.id === id);
      if (!r) throw new Error(`No reconciliation ${id}`);
      if (r.status !== 'open') throw new Error('Reconciliation is not open');
      if (!Number.isFinite(match.amount) || match.amount === 0) throw new Error('Match amount must be nonzero');
      const journal = journals.find((j) => j.date <= r.statementDate && j.lines.some((l) => l.id === match.journalLineId));
      const line = journal?.lines.find((l) => l.id === match.journalLineId);
      if (!line || line.accountCode !== r.accountCode) throw new Error('Journal line does not belong to reconciliation account or cutoff');
      if (reconciliations.some((x) => x.matches.some((m) => m.journalLineId === match.journalLineId))) throw new Error('Journal line is already matched');
      const value = cents(line.debit - line.credit);
      const amount = cents(match.amount);
      if (amount !== value) throw new Error('Match amount must equal the full signed journal line amount');
      r.matches.push({ ...match, amount });
    },
    async listTrustedDevices(repId) {
      return devices.filter((d) => d.repId === repId).map((d) => ({ ...d })).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    },
    async findTrustedDevice(tokenHash) {
      return devices.find((d) => d.tokenHash === tokenHash) ?? null;
    },
    async insertTrustedDevice(d) {
      devices.push({ ...d });
    },
    async touchTrustedDevice(id, patch) {
      const d = devices.find((x) => x.id === id);
      if (d) Object.assign(d, patch);
    },
    async deleteTrustedDevice(id) {
      const i = devices.findIndex((x) => x.id === id);
      if (i >= 0) devices.splice(i, 1);
    },
    async deleteTrustedDevices(repId) {
      for (let i = devices.length - 1; i >= 0; i--) if (devices[i]!.repId === repId) devices.splice(i, 1);
    },
    async listAllNotes() {
      return [...notes];
    },
    async listAllFiles() {
      return [...files];
    },
    async listAllRepFiles() {
      return [...repFiles];
    },
    async getSessionCutoff(repId) {
      return cutoffs.get(repId) ?? null;
    },
    async setSessionCutoff(repId, at) {
      cutoffs.set(repId, at);
    },
    async getCalendarToken(repId) {
      return calendarTokens.get(repId) ?? null;
    },
    async setCalendarToken(repId, token) {
      if (token) calendarTokens.set(repId, token);
      else calendarTokens.delete(repId);
    },
    async findRepByCalendarToken(token) {
      for (const [repId, t] of calendarTokens) if (t === token) return data.reps.find((r) => r.id === repId) ?? null;
      return null;
    },
    async listRepFiles(repId) {
      return repFiles.filter((f) => f.repId === repId).map(({ data: _d, ...meta }) => meta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getRepFile(id) {
      return repFiles.find((f) => f.id === id) ?? null;
    },
    async insertRepFile(f) {
      repFiles.push({ ...f });
    },
    async deleteRepFile(id) {
      const i = repFiles.findIndex((f) => f.id === id);
      if (i >= 0) repFiles.splice(i, 1);
    },
    async listPlaybooks() {
      return playbooks.map((p) => ({ ...p })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async insertPlaybook(p) {
      playbooks.push({ ...p });
    },
    async updatePlaybook(id, patch) {
      const p = playbooks.find((x) => x.id === id);
      if (!p) throw new Error(`No playbook ${id}`);
      Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    },
    async deletePlaybook(id) {
      const i = playbooks.findIndex((x) => x.id === id);
      if (i >= 0) playbooks.splice(i, 1);
      for (let k = firings.length - 1; k >= 0; k--) if (firings[k]!.playbookId === id) firings.splice(k, 1);
      for (const t of tasks) if (t.playbookId === id) t.playbookId = null;
    },
    async listFirings(opts = {}) {
      return firings
        .filter((f) => (!opts.playbookId || f.playbookId === opts.playbookId) && (!opts.dealId || f.dealId === opts.dealId))
        .sort((a, b) => b.firedAt.localeCompare(a.firedAt))
        .slice(0, opts.limit ?? 500);
    },
    async insertFiring(f) {
      firings.push({ ...f });
    },
    async listTasks(filter = {}) {
      return tasks
        .filter((t) => (!filter.repId || t.repId === filter.repId) && (!filter.dealId || t.dealId === filter.dealId) && (!filter.status || t.status === filter.status))
        .map((t) => ({ ...t }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.createdAt.localeCompare(b.createdAt));
    },
    async insertTask(t) {
      tasks.push({ ...t });
    },
    async updateTask(id, patch) {
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new Error(`No task ${id}`);
      Object.assign(t, patch);
    },
    async createPasswordReset(r) {
      resets.push({ ...r });
    },
    async findPasswordReset(tokenHash) {
      return resets.find((r) => r.tokenHash === tokenHash) ?? null;
    },
    async consumePasswordReset(id) {
      const r = resets.find((x) => x.id === id);
      if (r) r.usedAt = new Date().toISOString();
    },
    async getTotp(repId) {
      return totp.get(repId) ?? { secret: null, enabled: false };
    },
    async setTotp(repId, state) {
      if (state.secret) totp.set(repId, { ...state });
      else totp.delete(repId);
    },
    async repsWithTotp() {
      return [...totp.entries()].filter(([, s]) => s.enabled).map(([id]) => id);
    },
    async listNotes(dealId) {
      return notes.filter((n) => n.dealId === dealId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async insertNote(n) {
      notes.push({ ...n });
    },
    async deleteNote(id) {
      const i = notes.findIndex((n) => n.id === id);
      if (i >= 0) notes.splice(i, 1);
    },
    async listFiles(dealId) {
      return files.filter((f) => f.dealId === dealId).map(({ data: _d, ...meta }) => meta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getFile(id) {
      return files.find((f) => f.id === id) ?? null;
    },
    async insertFile(f) {
      files.push({ ...f });
    },
    async deleteFile(id) {
      const i = files.findIndex((f) => f.id === id);
      if (i >= 0) files.splice(i, 1);
    },
    audit,
    data,
    async getPasswordHash(repId) {
      return passwords.get(repId) ?? null;
    },
    async setPasswordHash(repId, hash) {
      if (hash) passwords.set(repId, hash);
      else passwords.delete(repId);
    },
    async repsWithPassword() {
      return [...passwords.keys()];
    },
    async findRepByEmail(email) {
      return data.reps.find((r) => r.email.toLowerCase() === email.trim().toLowerCase()) ?? null;
    },
    async findRep(id) {
      return data.reps.find((r) => r.id === id) ?? null;
    },
    async listReps() {
      return data.reps;
    },
    async listTeams() {
      return data.teams;
    },
    async listRuns() {
      return data.runs;
    },
    async loadContext() {
      return { ...ctx, clawbacks: data.clawbacks.filter((clawback) => !clawback.forgivenAt), adjustments: (data.adjustments ?? []).map((a) => ({ ...a })) };
    },
    async listWalletAdjustments() { return (data.adjustments ?? []).map((a) => ({ ...a })); },
    async createWalletAdjustment(a) {
      if (!a.amount || !Number.isFinite(a.amount) || Math.round(a.amount * 100) !== a.amount * 100) throw new Error('Adjustment amount must be nonzero exact cents');
      if (!a.reason.trim()) throw new Error('Adjustment reason is required');
      if (!data.deals.some((d) => d.id === a.dealId) || !data.reps.some((r) => r.id === a.repId)) throw new Error('Adjustment deal or rep not found');
      if ((data.adjustments ?? []).some((x) => x.idempotencyKey === a.idempotencyKey)) throw new Error('Adjustment idempotency key already exists');
      (data.adjustments ??= []).push({ ...a, reversalOf: null });
      return { ...a, reversalOf: null };
    },
    async reverseWalletAdjustment(id, reversal) {
      const original = (data.adjustments ?? []).find((a) => a.id === id);
      if (!original) throw new Error('Adjustment not found');
      if (original.reversalOf) throw new Error('Cannot reverse a reversal');
      const sameKey = (data.adjustments ?? []).find((a) => a.idempotencyKey === reversal.idempotencyKey);
      if (sameKey) {
        if (sameKey.reversalOf !== id || sameKey.dealId !== reversal.dealId || sameKey.repId !== reversal.repId || sameKey.amount !== reversal.amount) throw new Error('idempotency key conflicts with an existing adjustment');
        return { ...sameKey };
      }
      if ((data.adjustments ?? []).some((a) => a.reversalOf === id)) throw new Error('Adjustment has already been reversed');
      if (reversal.amount !== -original.amount) throw new Error('Reversal must be exact opposite');
      (data.adjustments ?? []).push({ ...reversal, dealId: original.dealId, repId: original.repId, reversalOf: id });
      return { ...reversal, dealId: original.dealId, repId: original.repId, reversalOf: id };
    },
    async getSetting<T>(key: string): Promise<T | null> {
      return ((data.settings as unknown as Record<string, unknown>)[key] as T) ?? null;
    },
    async claimSettingOnce(key: string, value: unknown = true): Promise<boolean> {
      const settings = data.settings as unknown as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(settings, key)) return false;
      settings[key] = value;
      return true;
    },
    async getSettings() {
      const s = data.settings;
      return { ...s, portal: { ...PORTAL_DEFAULTS, ...(s.portal ?? {}) }, notifications: { ...NOTIFICATION_DEFAULTS, ...(s.notifications ?? {}) }, security: { ...SECURITY_DEFAULTS, ...(s.security ?? {}) }, templates: { ...TEMPLATE_DEFAULTS, ...(s.templates ?? {}) }, permissions: { ...PERMISSION_DEFAULTS, ...(s.permissions ?? {}) } };
    },
    async writeAudit(e) {
      audit.push({ ...e, ip: e.ip ?? requestMeta()?.ip ?? null, at: new Date().toISOString() });
    },
    async getSyncIdempotency(operation, key) { return syncIdempotency.get(`${operation}\0${key}`) ?? null; },
    async putSyncIdempotency(record) { syncIdempotency.set(`${record.operation}\0${record.key}`, record); },
    async runSyncIdempotent<T>(operation: string, key: string, payloadHash: string, work: () => Promise<{ status: number; response: T }>) {
      const id = `${operation}\0${key}`;
      const previous = syncQueues.get(id) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.catch(() => undefined).then(() => current);
      syncQueues.set(id, tail);
      await previous.catch(() => undefined);
      try {
        const prior = syncIdempotency.get(id);
        if (prior) {
          if (prior.payloadHash !== payloadHash) throw new Error('Idempotency key was used with a different payload');
          return { status: prior.status ?? 500, response: prior.response as T, replayed: true };
        }
        const result = await work();
        syncIdempotency.set(id, { operation, key, payloadHash, state: 'completed', status: result.status, response: result.response });
        return { ...result, replayed: false };
      } finally {
        release();
        if (syncQueues.get(id) === tail) syncQueues.delete(id);
      }
    },
    async runSyncAtMostOnce<T>(operation: string, key: string, payloadHash: string, work: () => Promise<{ status: number; response: T }>) {
      const id = `${operation}\0${key}`;
      const previous = syncQueues.get(`claim:${id}`) ?? Promise.resolve();
      let releaseClaim!: () => void;
      const claim = new Promise<void>((resolve) => { releaseClaim = resolve; });
      const tail = previous.catch(() => undefined).then(() => claim);
      syncQueues.set(`claim:${id}`, tail);
      await previous.catch(() => undefined);
      const prior = syncIdempotency.get(id);
      if (prior) {
        releaseClaim();
        if (prior.payloadHash !== payloadHash) throw new Error('Idempotency key was used with a different payload');
        if (prior.state === 'processing') throw new Error('Sync operation is processing or uncertain; reconcile before retrying');
        return { status: prior.status ?? 500, response: prior.response as T, replayed: true };
      }
      syncIdempotency.set(id, { operation, key, payloadHash, state: 'processing', status: null, response: null });
      try {
        const result = await work();
        syncIdempotency.set(id, { operation, key, payloadHash, state: 'completed', status: result.status, response: result.response });
        return { ...result, replayed: false };
      } catch (error) {
        const response = { error: error instanceof Error ? error.message : 'Sync operation failed' };
        syncIdempotency.set(id, { operation, key, payloadHash, state: 'failed', status: 500, response });
        throw error;
      } finally {
        releaseClaim();
        if (syncQueues.get(`claim:${id}`) === tail) syncQueues.delete(`claim:${id}`);
      }
    },
    async listAudit(limit = 100, offset = 0) {
      const all = [...audit].reverse();
      return all.slice(offset, offset + limit);
    },
    async insertDeal(deal) {
      data.deals.unshift({ ...deal, draws: [...deal.draws] });
    },
    async insertClawback(c) {
      data.clawbacks.push({ ...c, forgivenAt: c.forgivenAt ?? null });
    },
    async updateClawback(id, patch) {
      const i = data.clawbacks.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`No clawback ${id}`);
      data.clawbacks[i] = { ...data.clawbacks[i]!, ...patch };
    },
    async updateClawbackLocked(dealId, id, patch, validate) {
      const deal = data.deals.find((x) => x.id === dealId);
      if (!deal) throw new Error(`No deal ${dealId}`);
      const clawback = data.clawbacks.find((x) => x.id === id);
      if (!clawback) throw new Error(`No clawback ${id}`);
      validate(deal, clawback, data.lines.filter((line) => line.dealId === dealId));
      Object.assign(clawback, patch);
    },
    async deleteClawback(id) {
      const clawback = data.clawbacks.find((x) => x.id === id);
      if (clawback && !clawback.forgivenAt) clawback.forgivenAt = new Date().toISOString();
    },
    async mutateClawback<T>(dealId: string, clawbackId: string | null, mutate: (context: ClawbackMutationContext) => import('./repo.js').ClawbackMutation<T> | Promise<import('./repo.js').ClawbackMutation<T>>): Promise<T> {
      return serializeDeal(dealId, async () => {
        const deal = data.deals.find((x) => x.id === dealId);
        if (!deal) throw new Error(`No deal ${dealId}`);
        const target = clawbackId === null ? null : data.clawbacks.find((x) => x.id === clawbackId && x.dealId === dealId) ?? null;
        if (clawbackId !== null && !target) throw new Error(`No clawback ${clawbackId} on deal ${dealId}`);
        const mutation = await mutate({
          deal: { ...deal, draws: deal.draws.map((draw) => ({ ...draw })) },
          clawback: target ? { ...target } : null,
          activeClawbacks: data.clawbacks.filter((c) => c.dealId === dealId && !c.forgivenAt).map((c) => ({ ...c })),
          lines: data.lines.filter((line) => line.dealId === dealId).map((line) => ({ ...line })),
        });
        const writes = Number(!!mutation.create) + Number(!!mutation.update) + Number(!!mutation.forgive);
        if (writes > 1) throw new Error('A clawback mutation may create, update, or forgive, not multiple lifecycle writes');
        if (mutation.create) {
          if (clawbackId !== null || mutation.create.dealId !== dealId) throw new Error('Clawback create must use the locked deal and no target id');
          if (data.clawbacks.some((c) => c.id === mutation.create!.id)) throw new Error(`Clawback ${mutation.create.id} already exists`);
          data.clawbacks.push({ ...mutation.create, forgivenAt: mutation.create.forgivenAt ?? null });
        } else if (mutation.update) {
          if (!target) throw new Error('Clawback update requires a target');
          Object.assign(target, mutation.update);
        } else if (mutation.forgive) {
          if (!target) throw new Error('Clawback forgive requires a target');
          target.forgivenAt = new Date().toISOString();
        }
        return mutation.result;
      });
    },
    async renameRef(kind, from, to) {
      let n = 0;
      for (const d of data.deals) {
        if (kind === 'lender' && d.lender === from) { d.lender = to; n++; }
        if (kind === 'product' && d.product === from) { d.product = to; n++; }
        if (kind === 'partner' && d.referralPartner === from) { d.referralPartner = to; n++; }
      }
      return n;
    },
    async deleteDeal(id) {
      const i = data.deals.findIndex((d) => d.id === id);
      if (i >= 0) data.deals.splice(i, 1);
    },
    async updateDeal(id, patch: DealPatch) {
      const i = data.deals.findIndex((d) => d.id === id);
      if (i < 0) throw new Error(`No deal ${id}`);
      data.deals[i] = { ...data.deals[i]!, ...patch };
    },
    async updateDealLocked(id, patch, validate) {
      const d = data.deals.find((x) => x.id === id);
      if (!d) throw new Error(`No deal ${id}`);
      // Memory writes run synchronously between awaits, matching the locked DB critical section.
      validate(d, data.lines.filter((line) => line.dealId === id), data.clawbacks.filter((clawback) => clawback.dealId === id));
      Object.assign(d, patch);
    },
    async insertDraw(dealId, draw: DealDraw) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      d.draws = [...d.draws, draw];
    },
    async insertDrawLocked(dealId, build) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      const draw = build(d, data.lines.filter((line) => line.dealId === dealId), data.clawbacks.filter((clawback) => clawback.dealId === dealId));
      d.draws = [...d.draws, draw];
      return draw;
    },
    async updateDraw(dealId, ref, patch: { collected: number | null; schedule: WeeklySchedule | null }) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      d.draws = d.draws.map((x) => (x.ref === ref ? { ...x, ...patch } : x));
    },
    async updateSegmentLocked(dealId, segmentKey, build) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      const patch = build(d, data.lines.filter((line) => line.dealId === dealId), data.clawbacks.filter((clawback) => clawback.dealId === dealId));
      if (segmentKey === 'base') {
        d.commCollected = patch.collected;
        d.commSchedule = patch.schedule;
        if (patch.lenderPaid !== undefined) d.lenderPaid = patch.lenderPaid;
      } else {
        d.draws = d.draws.map((x) => (x.ref === segmentKey ? { ...x, collected: patch.collected, schedule: patch.schedule } : x));
      }
    },
    async replaceDraw(dealId, ref, draw) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      d.draws = d.draws.map((x) => (x.ref === ref ? { ...draw, ref } : x));
    },
    async replaceDrawLocked(dealId, ref, build) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      const draw = build(d, data.lines.filter((line) => line.dealId === dealId), data.clawbacks.filter((clawback) => clawback.dealId === dealId));
      d.draws = d.draws.map((x) => (x.ref === ref ? { ...draw, ref } : x));
      return draw;
    },
    async deleteDraw(dealId, ref) {
      const d = data.deals.find((x) => x.id === dealId);
      if (d) d.draws = d.draws.filter((x) => x.ref !== ref);
    },
    async deleteDrawLocked(dealId, ref, validate) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      const proposed = { ...d, draws: d.draws.filter((draw) => draw.ref !== ref) };
      validate(proposed, data.lines.filter((line) => line.dealId === dealId), data.clawbacks.filter((clawback) => clawback.dealId === dealId));
      d.draws = proposed.draws;
    },
    async deleteRun(id) {
      const i = data.runs.findIndex((r) => r.id === id);
      if (i >= 0) data.runs.splice(i, 1);
    },
    async insertRun(run: PayrollRun) {
      data.runs.unshift({ ...run });
    },
    async updateRun(id, patch) {
      const i = data.runs.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`No run ${id}`);
      data.runs[i] = { ...data.runs[i]!, ...(patch.status ? { status: patch.status } : {}), ...(patch.label ? { label: patch.label } : {}) };
    },
    async transitionRun(id, from, patch) {
      const i = data.runs.findIndex((r) => r.id === id && from.includes(r.status));
      if (i < 0) return false;
      data.runs[i] = { ...data.runs[i]!, ...(patch.status ? { status: patch.status } : {}), ...(patch.label ? { label: patch.label } : {}) };
      return true;
    },
    async putSetting(key, value) {
      (data.settings as unknown as Record<string, unknown>)[key] = value;
    },
    async insertTeam(team) {
      data.teams.push({ ...team });
    },
    async updateTeam(id, patch) {
      const i = data.teams.findIndex((t) => t.id === id);
      if (i < 0) throw new Error(`No team ${id}`);
      data.teams[i] = { ...data.teams[i]!, ...patch };
    },
    async deleteTeam(id) {
      const i = data.teams.findIndex((t) => t.id === id);
      if (i >= 0) data.teams.splice(i, 1);
    },
    async insertRep(rep) {
      data.reps.push({ ...rep });
    },
    async updateRep(id, patch) {
      const i = data.reps.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`No rep ${id}`);
      data.reps[i] = { ...data.reps[i]!, ...patch };
    },
    async commitPayout(c: PayoutCommit) {
      await serializePayouts(c.lines.map((line) => line.repId), () => {
        for (const l of c.lines) if (data.lines.some((x) => x.key === l.key)) throw new Error(`Ledger key ${l.key} already exists`);
        data.lines.push(...c.lines);
        for (const u of c.clawbackUpdates) {
          const i = data.clawbacks.findIndex((x) => x.id === u.id);
          if (i >= 0) data.clawbacks[i] = { ...data.clawbacks[i]!, recovered: u.recovered, status: u.status };
        }
        for (const id of c.dealsFullyPaid) {
          const i = data.deals.findIndex((d) => d.id === id);
          if (i >= 0 && !data.deals[i]!.repPaid) data.deals[i] = { ...data.deals[i]!, repPaid: c.paidAt };
        }
        for (const id of c.dealsUnstamped ?? []) {
          const i = data.deals.findIndex((d) => d.id === id);
          if (i >= 0) data.deals[i] = { ...data.deals[i]!, repPaid: null };
        }
      });
    },
    async commitPayoutForOpenRun(runId, c, validateDeals) {
      return serializePayouts(c.lines.map((line) => line.repId), () => {
      // This check and append have no await between them: the memory repo models
      // the same conditional claim that the SQL implementation locks in one tx.
      if (!data.runs.some((r) => r.id === runId && (r.status === 'draft' || r.status === 'approved'))) return false;
      const currentDeals = [...new Set(c.lines.map((line) => line.dealId))]
        .sort()
        .map((id) => data.deals.find((deal) => deal.id === id))
        .filter((deal): deal is Deal => !!deal);
      if (currentDeals.length !== new Set(c.lines.map((line) => line.dealId)).size) return false;
      if (validateDeals && !validateDeals(currentDeals)) return false;
      for (const l of c.lines) if (data.lines.some((x) => x.key === l.key)) throw new Error(`Ledger key ${l.key} already exists`);
      data.lines.push(...c.lines);
      for (const u of c.clawbackUpdates) {
        const i = data.clawbacks.findIndex((x) => x.id === u.id);
        if (i >= 0) data.clawbacks[i] = { ...data.clawbacks[i]!, recovered: u.recovered, status: u.status };
      }
      for (const id of c.dealsFullyPaid) {
        const i = data.deals.findIndex((d) => d.id === id);
        if (i >= 0 && !data.deals[i]!.repPaid) data.deals[i] = { ...data.deals[i]!, repPaid: c.paidAt };
      }
      for (const id of c.dealsUnstamped ?? []) {
        const i = data.deals.findIndex((d) => d.id === id);
        if (i >= 0) data.deals[i] = { ...data.deals[i]!, repPaid: null };
      }
      return true;
      });
    },
    async commitPayoutForUnarchivedRun(runId, c) {
      return serializePayouts(c.lines.map((line) => line.repId), () => {
      // Kept separate from the open-run path because paid runs intentionally
      // support Void corrections, while archived runs are immutable.
      if (!data.runs.some((r) => r.id === runId && r.status !== 'archived')) return false;
      for (const l of c.lines) if (data.lines.some((x) => x.key === l.key)) throw new Error(`Ledger key ${l.key} already exists`);
      data.lines.push(...c.lines);
      for (const u of c.clawbackUpdates) {
        const i = data.clawbacks.findIndex((x) => x.id === u.id);
        if (i >= 0) data.clawbacks[i] = { ...data.clawbacks[i]!, recovered: u.recovered, status: u.status };
      }
      for (const id of c.dealsFullyPaid) {
        const i = data.deals.findIndex((d) => d.id === id);
        if (i >= 0 && !data.deals[i]!.repPaid) data.deals[i] = { ...data.deals[i]!, repPaid: c.paidAt };
      }
      for (const id of c.dealsUnstamped ?? []) {
        const i = data.deals.findIndex((d) => d.id === id);
        if (i >= 0) data.deals[i] = { ...data.deals[i]!, repPaid: null };
      }
      return true;
      });
    },
    async planPayoutForRun(runId, repId, allowed, plan) {
      return serializePayout(repId, () => {
        // Keep planning and applying in one synchronous critical section. This
        // mirrors the database's rep advisory lock and locked context reload.
        if (!data.runs.some((r) => r.id === runId && allowed.includes(r.status as 'draft' | 'approved' | 'paid'))) return null;
        const planned = plan({
          deals: data.deals.map((deal) => ({ ...deal, draws: deal.draws.map((draw) => ({ ...draw })) })),
          lines: data.lines.map((line) => ({ ...line })),
          clawbacks: data.clawbacks.filter((clawback) => !clawback.forgivenAt).map((clawback) => ({ ...clawback })),
        });
        const c = planned.commit;
        for (const l of c.lines) if (data.lines.some((x) => x.key === l.key)) throw new Error(`Ledger key ${l.key} already exists`);
        data.lines.push(...c.lines);
        for (const u of c.clawbackUpdates) {
          const i = data.clawbacks.findIndex((x) => x.id === u.id);
          if (i >= 0) data.clawbacks[i] = { ...data.clawbacks[i]!, recovered: u.recovered, status: u.status };
        }
        for (const id of c.dealsFullyPaid) {
          const i = data.deals.findIndex((d) => d.id === id);
          if (i >= 0 && !data.deals[i]!.repPaid) data.deals[i] = { ...data.deals[i]!, repPaid: c.paidAt };
        }
        for (const id of c.dealsUnstamped ?? []) {
          const i = data.deals.findIndex((d) => d.id === id);
          if (i >= 0) data.deals[i] = { ...data.deals[i]!, repPaid: null };
        }
        return planned.result;
      });
    },
  };
}
