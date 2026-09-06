/**
 * Rep scorecards: production, renewal conversion and follow-through, for a
 * year. "Owner" of a deal is the closer, else the opener — the person the
 * renewal engine and the playbooks hold responsible for the call.
 */
import { renewalOf, sum, totalFunded, totalGross, type LedgerContext, type Rep } from '@greystone/commission';
import type { RepTask, Settings } from '../repo.js';
import { TASK_OUTCOMES } from './playbook-rules.js';

export interface Scorecard {
  repId: string;
  name: string;
  team: string | null;
  active: boolean;
  /** Deals funded this year where the rep opened, closed or overrides. */
  deals: number;
  funded: number;
  gross: number;
  /** Deals owned that were renewed into a later deal (any year) ÷ deals owned that reached the renewal mark. */
  renewable: number;
  renewed: number;
  renewalRate: number | null;
  /** Tasks closed this year with "funded" or "app submitted" ÷ tasks closed with any final outcome. */
  tasksClosed: number;
  tasksWon: number;
  taskWinRate: number | null;
  /** Closed on or before the due date ÷ closed. */
  onTimeRate: number | null;
  openTasks: number;
  overdueTasks: number;
  /** Median days from task creation to close. */
  daysToClose: number | null;
}

export function scorecards(ctx: LedgerContext, reps: Rep[], teams: Array<{ id: string; name: string }>, settings: Settings, tasks: RepTask[], year: number, today: string): Scorecard[] {
  const prefix = `${year}-`;
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const final = new Set(TASK_OUTCOMES.filter((o) => o.closes).map((o) => o.value));
  const won = new Set(['funded', 'app_submitted']);
  return reps
    .map((rep) => {
      const involved = ctx.deals.filter((d) => d.date.startsWith(prefix) && (d.openerId === rep.id || d.closerId === rep.id || d.overrideId === rep.id));
      const owned = ctx.deals.filter((d) => (d.closerId ?? d.openerId) === rep.id);
      const renewable = owned.filter((d) => {
        const r = renewalOf(d, settings.thresholds, today);
        return r.bucket !== 'building' && r.bucket !== 'risk';
      });
      const renewed = renewable.filter((d) => ctx.deals.some((x) => x.renewedFromId === d.id));
      const mine = tasks.filter((t) => t.repId === rep.id);
      const closed = mine.filter((t) => t.status === 'done' && t.doneAt && t.doneAt.startsWith(prefix) && t.outcome && final.has(t.outcome));
      const wonT = closed.filter((t) => won.has(t.outcome!));
      const onTime = closed.filter((t) => t.doneAt!.slice(0, 10) <= t.dueDate);
      const days = closed.map((t) => Math.round((Date.parse(t.doneAt!) - Date.parse(t.createdAt)) / 86_400_000)).sort((a, b) => a - b);
      const open = mine.filter((t) => t.status === 'open');
      return {
        repId: rep.id,
        name: rep.name,
        team: rep.teamId ? teamName.get(rep.teamId) ?? null : null,
        active: rep.active,
        deals: involved.length,
        funded: sum(involved.map(totalFunded)),
        gross: sum(involved.map(totalGross)),
        renewable: renewable.length,
        renewed: renewed.length,
        renewalRate: renewable.length ? Math.round((renewed.length / renewable.length) * 100) : null,
        tasksClosed: closed.length,
        tasksWon: wonT.length,
        taskWinRate: closed.length ? Math.round((wonT.length / closed.length) * 100) : null,
        onTimeRate: closed.length ? Math.round((onTime.length / closed.length) * 100) : null,
        openTasks: open.length,
        overdueTasks: open.filter((t) => t.dueDate < today).length,
        daysToClose: days.length ? days[Math.floor(days.length / 2)]! : null,
      };
    })
    .filter((s) => s.active || s.deals > 0)
    .sort((a, b) => b.funded - a.funded);
}
