import type { Clawback, Deal, DealDraw, LedgerContext, PayoutLine, PayrollRun, Rep, Team, WeeklySchedule } from '@greystone/commission';
import { NOTIFICATION_DEFAULTS, PORTAL_DEFAULTS, SECURITY_DEFAULTS, type AuditEntry, type DealFile, type DealNote, type DealPatch, type PasswordReset, type PayoutCommit, type Playbook, type PlaybookFiring, type Repo, type RepFile, type RepTask, type Settings, type TotpState } from './repo.js';
import { requestMeta } from './auth/request-context.js';

export interface MemoryData {
  reps: Rep[];
  teams: Team[];
  runs: PayrollRun[];
  deals: Deal[];
  lines: PayoutLine[];
  clawbacks: Clawback[];
  settings: Omit<Settings, 'portal' | 'notifications' | 'security'> & Partial<Pick<Settings, 'portal' | 'notifications' | 'security'>>;
}

/** In-memory Repo over plain arrays. Mutates the arrays it is given. */
export function memoryRepo(data: MemoryData): Repo & { audit: AuditEntry[]; data: MemoryData } {
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
  return {
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
      return ctx;
    },
    async getSetting<T>(key: string): Promise<T | null> {
      return ((data.settings as unknown as Record<string, unknown>)[key] as T) ?? null;
    },
    async getSettings() {
      const s = data.settings;
      return { ...s, portal: { ...PORTAL_DEFAULTS, ...(s.portal ?? {}) }, notifications: { ...NOTIFICATION_DEFAULTS, ...(s.notifications ?? {}) }, security: { ...SECURITY_DEFAULTS, ...(s.security ?? {}) } };
    },
    async writeAudit(e) {
      audit.push({ ...e, ip: e.ip ?? requestMeta()?.ip ?? null, at: new Date().toISOString() });
    },
    async listAudit(limit = 100, offset = 0) {
      const all = [...audit].reverse();
      return all.slice(offset, offset + limit);
    },
    async insertDeal(deal) {
      data.deals.unshift({ ...deal, draws: [...deal.draws] });
    },
    async insertClawback(c) {
      data.clawbacks.push({ ...c });
    },
    async updateClawback(id, patch) {
      const i = data.clawbacks.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`No clawback ${id}`);
      data.clawbacks[i] = { ...data.clawbacks[i]!, ...patch };
    },
    async deleteClawback(id) {
      const i = data.clawbacks.findIndex((x) => x.id === id);
      if (i >= 0) data.clawbacks.splice(i, 1);
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
    async insertDraw(dealId, draw: DealDraw) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      d.draws = [...d.draws, draw];
    },
    async updateDraw(dealId, ref, patch: { collected: number | null; schedule: WeeklySchedule | null }) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      d.draws = d.draws.map((x) => (x.ref === ref ? { ...x, ...patch } : x));
    },
    async replaceDraw(dealId, ref, draw) {
      const d = data.deals.find((x) => x.id === dealId);
      if (!d) throw new Error(`No deal ${dealId}`);
      d.draws = d.draws.map((x) => (x.ref === ref ? { ...draw, ref } : x));
    },
    async deleteDraw(dealId, ref) {
      const d = data.deals.find((x) => x.id === dealId);
      if (d) d.draws = d.draws.filter((x) => x.ref !== ref);
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
    },
  };
}
