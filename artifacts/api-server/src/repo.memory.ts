import type { Clawback, Deal, DealDraw, LedgerContext, PayoutLine, PayrollRun, Rep, Team, WeeklySchedule } from '@greystone/commission';
import type { AuditEntry, DealPatch, PayoutCommit, Repo, Settings } from './repo.js';

export interface MemoryData {
  reps: Rep[];
  teams: Team[];
  runs: PayrollRun[];
  deals: Deal[];
  lines: PayoutLine[];
  clawbacks: Clawback[];
  settings: Settings;
}

/** In-memory Repo over plain arrays. Mutates the arrays it is given. */
export function memoryRepo(data: MemoryData): Repo & { audit: AuditEntry[]; data: MemoryData } {
  const audit: AuditEntry[] = [];
  const ctx: LedgerContext = data;
  const passwords = new Map<string, string>();
  return {
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
      return data.settings;
    },
    async writeAudit(e) {
      audit.push({ ...e, at: new Date().toISOString() });
    },
    async listAudit(limit = 100) {
      return audit.slice(-limit).reverse();
    },
    async insertDeal(deal) {
      data.deals.unshift({ ...deal, draws: [...deal.draws] });
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
    },
  };
}
