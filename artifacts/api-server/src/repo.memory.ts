import type { Clawback, Deal, DealDraw, LedgerContext, PayoutLine, PayrollRun, Rep, Team, WeeklySchedule } from '@greystone/commission';
import type { AuditEntry, DealPatch, Repo, Settings } from './repo.js';

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
  return {
    audit,
    data,
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
  };
}
