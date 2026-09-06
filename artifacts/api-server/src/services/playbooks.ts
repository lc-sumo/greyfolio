/**
 * Playbooks: if/then rules that act on the renewal engine's facts.
 *
 *   trigger (paid-in %, days since funding, stage, unused line, …)
 *   + filters (lender, product, team, rep, size)
 *   → actions (email the rep, email admins, open a task, set a status)
 *
 * One evaluation a day (the scheduler), or on demand. A rule fires once per
 * deal, or again every `repeatDays` while the condition holds, and never
 * again once a task it opened was closed with a final outcome. Rep emails
 * roll up: one message per rep per run, whatever fired.
 */
import { RENEWAL_BUCKET_LABEL, clawbackWindow, crmUrl, effectiveDealStatus, renewalOf, totalFunded, type Deal, type LedgerContext, type Rep } from '@greystone/commission';
import { HttpError } from '../http-error.js';
import type { DealNote, Playbook, PlaybookFiring, Repo, RepTask, Settings, TaskOutcome } from '../repo.js';
import { overdueDealIds } from './books.js';
import type { Mail, Mailer } from './mail.js';
import { TASK_OUTCOMES, daysBetween, mergeFields, normalizeRule, renderTemplate, ruleMatches, type DealFacts, type PlaybookRule } from './playbook-rules.js';

export interface PlaybookDeps {
  repo: Repo;
  mailer: Mailer;
  origin: string;
  appName: string;
}

const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Everything a rule can look at, for every deal, computed once. */
export function dealFacts(ctx: LedgerContext, reps: Rep[], settings: Settings, notes: DealNote[], today: string): DealFacts[] {
  const overdue = overdueDealIds(ctx, settings, today);
  const lastNote = new Map<string, string>();
  for (const n of notes) if (!lastNote.has(n.dealId) || n.createdAt > lastNote.get(n.dealId)!) lastNote.set(n.dealId, n.createdAt);
  const repOf = new Map(reps.map((r) => [r.id, r]));
  return ctx.deals.map((d) => {
    const r = renewalOf(d, settings.thresholds, today);
    const ownerRepId = d.closerId ?? d.openerId;
    const owner = ownerRepId ? repOf.get(ownerRepId) : undefined;
    const funded = totalFunded(d);
    const cw = clawbackWindow(d, { lender: settings.lenders.find((l) => l.name === d.lender) ?? null, rule: settings.products.find((p) => p.name === d.product) ?? null, defaultDays: settings.thresholds.clawbackWindowDays }, today);
    const noteAt = lastNote.get(d.id);
    return {
      dealId: d.id,
      business: d.business,
      lender: d.lender,
      product: d.product,
      funded,
      fundedDate: d.date,
      teamId: owner?.teamId ?? null,
      ownerRepId: ownerRepId ?? null,
      ownerFirst: owner ? owner.name.split(' ')[0]! : 'there',
      paidInPct: Math.min(100, Math.round(r.pctPaidIn * 1000) / 10),
      daysSinceFunding: daysBetween(d.date, today),
      daysToMaturity: r.maturityDate ? daysBetween(today, r.maturityDate) : null,
      bucket: r.bucket,
      bucketLabel: RENEWAL_BUCKET_LABEL[r.bucket],
      locUnused: d.creditLine ? Math.max(0, d.creditLine - funded) : 0,
      status: effectiveDealStatus(d, settings.thresholds, today),
      lenderOverdue: overdue.has(d.id),
      clawbackDaysLeft: cw.cleared ? null : cw.daysLeft,
      daysSinceLastNote: noteAt ? daysBetween(noteAt.slice(0, 10), today) : null,
      estEligible: d.creditLine ? Math.max(0, d.creditLine - funded) : Math.round(funded * r.pctPaidIn),
      estRenewalGross: r.estRenewalGross,
      crmUrl: crmUrl(settings.crm.urlTemplate, d) || null,
      merchantContact: d.merchantContact,
      merchantEmail: d.merchantEmail,
      merchantPhone: d.merchantPhone,
    };
  });
}

export interface Match {
  playbook: Playbook;
  facts: DealFacts;
}

/** Which (rule, deal) pairs would fire today, honouring once/repeat and closed tasks. */
export async function pendingMatches(repo: Repo, playbooks: Playbook[], facts: DealFacts[], today: string): Promise<Match[]> {
  const firings = await repo.listFirings({ limit: 100_000 });
  const tasks = await repo.listTasks();
  const out: Match[] = [];
  for (const p of playbooks) {
    if (!p.enabled) continue;
    for (const f of facts) {
      if (!ruleMatches(p.rule, f)) continue;
      const mine = firings.filter((x) => x.playbookId === p.id && x.dealId === f.dealId);
      if (mine.length) {
        if (p.rule.repeatDays === null) continue;
        const last = mine.map((x) => x.firedAt).sort().at(-1)!.slice(0, 10);
        if (daysBetween(last, today) < p.rule.repeatDays) continue;
      }
      const ts = tasks.filter((t) => t.playbookId === p.id && t.dealId === f.dealId);
      if (ts.some((t) => t.status === 'open')) continue; // the open task is the reminder
      if (ts.some((t) => t.status === 'done' && t.outcome && TASK_OUTCOMES.find((o) => o.value === t.outcome)?.closes)) continue;
      out.push({ playbook: p, facts: f });
    }
  }
  return out;
}

export interface RunResult {
  date: string;
  fired: number;
  emails: number;
  tasks: number;
  statuses: number;
  byPlaybook: Array<{ id: string; name: string; deals: number }>;
}

/** Evaluate every enabled playbook and act. */
export async function runPlaybooks(deps: PlaybookDeps, today: string, actorRepId?: string): Promise<RunResult> {
  const { repo } = deps;
  const [ctx, reps, settings, notes, playbooks] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings(), repo.listAllNotes(), repo.listPlaybooks()]);
  const facts = dealFacts(ctx, reps, settings, notes, today);
  const matches = await pendingMatches(repo, playbooks, facts, today);
  const appName = settings.portal.company && settings.portal.portal ? `${settings.portal.company} ${settings.portal.portal}` : deps.appName;
  const admins = reps.filter((r) => r.active && r.role === 'admin');
  const repMail = new Map<string, Array<{ subject: string; body: string; playbook: string }>>();
  const adminMail: Array<{ subject: string; body: string; playbook: string; rep: string }> = [];
  let tasks = 0;
  let statuses = 0;
  const byPlaybook = new Map<string, number>();
  for (const { playbook, facts: f } of matches) {
    const owner = f.ownerRepId ? reps.find((r) => r.id === f.ownerRepId) : undefined;
    const fields = mergeFields(f, { link: `${deps.origin}/deals`, repName: owner?.name, company: settings.portal.company });
    const done: string[] = [];
    for (const a of playbook.rule.actions) {
      if (a.kind === 'emailRep') {
        if (!owner || !owner.active) continue;
        repMail.set(owner.id, [...(repMail.get(owner.id) ?? []), { subject: renderTemplate(a.subject, fields), body: renderTemplate(a.body, fields), playbook: playbook.name }]);
        done.push('emailRep');
      } else if (a.kind === 'emailAdmins') {
        adminMail.push({ subject: renderTemplate(a.subject, fields), body: renderTemplate(a.body, fields), playbook: playbook.name, rep: owner?.name ?? '—' });
        done.push('emailAdmins');
      } else if (a.kind === 'task') {
        if (!owner || !owner.active) continue;
        const t: RepTask = { id: id('task'), dealId: f.dealId, repId: owner.id, playbookId: playbook.id, title: renderTemplate(a.title, fields), dueDate: addDays(today, a.dueInDays), status: 'open', outcome: null, note: null, createdBy: null, createdAt: new Date().toISOString(), doneAt: null };
        await repo.insertTask(t);
        tasks++;
        done.push('task');
      } else if (a.kind === 'setStatus') {
        await repo.updateDeal(f.dealId, { dealStatus: a.status });
        statuses++;
        done.push(`status:${a.status}`);
      }
    }
    // Stamped with the evaluation day (the clock's time of day), so repeat windows count from the run, not the wall clock.
    const firing: PlaybookFiring = { id: id('fire'), playbookId: playbook.id, dealId: f.dealId, repId: owner?.id ?? null, firedAt: `${today}T${new Date().toISOString().slice(11)}`, detail: { actions: done, business: f.business, trigger: playbook.rule.trigger.kind } };
    await repo.insertFiring(firing);
    byPlaybook.set(playbook.id, (byPlaybook.get(playbook.id) ?? 0) + 1);
  }
  let emails = 0;
  const send = async (to: string | string[], mail: Mail, why: string, targetRepId: string | null) => {
    if (!deps.mailer.live && deps.mailer.kind !== 'log') return;
    const r = await deps.mailer.send({ ...mail, to });
    await repo.writeAudit({ actorRepId: actorRepId ?? admins[0]?.id ?? 'system', action: 'mail.sent', targetRepId, path: null, detail: { to, subject: mail.subject, why, ok: r.ok, ...(r.error ? { error: r.error } : {}) } });
    if (r.ok) emails++;
  };
  for (const [repId, items] of repMail) {
    const rep = reps.find((r) => r.id === repId)!;
    const subject = items.length === 1 ? items[0]!.subject : `${items.length} deals need a call — ${today}`;
    const text = [`Hi ${rep.name.split(' ')[0]},`, '', ...items.flatMap((i) => [i.body, '', `— ${i.playbook}`, '', '· · ·', '']), `Your tasks: ${deps.origin}/`, '', `— ${appName}`].join('\n');
    await send(rep.email, { to: rep.email, subject, text }, 'playbook', rep.id);
  }
  if (adminMail.length && admins.length) {
    const subject = adminMail.length === 1 ? adminMail[0]!.subject : `${adminMail.length} playbook alerts — ${today}`;
    const text = [...adminMail.flatMap((i) => [`[${i.playbook} · rep ${i.rep}]`, i.body, '']), `Books: ${deps.origin}/books`, '', `— ${appName}`].join('\n');
    await send(admins.map((a) => a.email), { to: admins.map((a) => a.email), subject, text }, 'playbook admins', null);
  }
  const result: RunResult = { date: today, fired: matches.length, emails, tasks, statuses, byPlaybook: playbooks.map((p) => ({ id: p.id, name: p.name, deals: byPlaybook.get(p.id) ?? 0 })) };
  if (matches.length) await repo.writeAudit({ actorRepId: actorRepId ?? admins[0]?.id ?? 'system', action: 'playbook.fired', targetRepId: null, path: '/playbooks/run', detail: { ...result, byPlaybook: result.byPlaybook.filter((b) => b.deals) } });
  return result;
}

export interface DryRunRow {
  dealId: string;
  business: string;
  lender: string;
  funded: number;
  rep: string;
  stage: string;
  paidIn: string;
  daysSinceFunding: number;
  /** Would fire today, or is held back (already fired, open task, closed task). */
  held: string | null;
}

/** "This rule would fire for N deals today": the deals, and the first email rendered. */
export async function dryRun(repo: Repo, ruleInput: unknown, today: string, playbookId?: string): Promise<{ rows: DryRunRow[]; wouldFire: number; matched: number; preview: { subject: string; body: string } | null }> {
  let rule: PlaybookRule;
  try {
    rule = normalizeRule(ruleInput);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'Invalid rule');
  }
  const [ctx, reps, settings, notes] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings(), repo.listAllNotes()]);
  const facts = dealFacts(ctx, reps, settings, notes, today).filter((f) => ruleMatches(rule, f));
  const firings = playbookId ? await repo.listFirings({ playbookId, limit: 100_000 }) : [];
  const tasks = playbookId ? (await repo.listTasks()).filter((t) => t.playbookId === playbookId) : [];
  const rows: DryRunRow[] = facts.map((f) => {
    const mine = firings.filter((x) => x.dealId === f.dealId);
    const ts = tasks.filter((t) => t.dealId === f.dealId);
    let held: string | null = null;
    if (ts.some((t) => t.status === 'open')) held = 'open task';
    else if (ts.some((t) => t.status === 'done' && t.outcome && TASK_OUTCOMES.find((o) => o.value === t.outcome)?.closes)) held = 'task closed';
    else if (mine.length && rule.repeatDays === null) held = 'already fired';
    else if (mine.length && daysBetween(mine.map((x) => x.firedAt).sort().at(-1)!.slice(0, 10), today) < rule.repeatDays!) held = `fired ${mine.map((x) => x.firedAt).sort().at(-1)!.slice(0, 10)}`;
    const owner = f.ownerRepId ? reps.find((r) => r.id === f.ownerRepId) : undefined;
    return { dealId: f.dealId, business: f.business, lender: f.lender, funded: f.funded, rep: owner?.name ?? '—', stage: f.bucketLabel, paidIn: `${Math.round(f.paidInPct)}%`, daysSinceFunding: f.daysSinceFunding, held };
  });
  const first = facts[0];
  const mail = rule.actions.find((a): a is Extract<PlaybookRule['actions'][number], { kind: 'emailRep' | 'emailAdmins' }> => a.kind === 'emailRep' || a.kind === 'emailAdmins');
  const preview = first && mail ? (() => { const fields = mergeFields(first, { link: 'https://portal/deals', repName: reps.find((r) => r.id === first.ownerRepId)?.name, company: settings.portal.company }); return { subject: renderTemplate(mail.subject, fields), body: renderTemplate(mail.body, fields) }; })() : null;
  return { rows, wouldFire: rows.filter((r) => !r.held).length, matched: rows.length, preview };
}

/* ---------- CRUD ---------- */

export async function createPlaybook(repo: Repo, input: { name?: unknown; enabled?: unknown; rule?: unknown }, actorRepId: string): Promise<Playbook> {
  const name = String(input.name ?? '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'Give the playbook a name');
  let rule: PlaybookRule;
  try {
    rule = normalizeRule(input.rule);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'Invalid rule');
  }
  const now = new Date().toISOString();
  const p: Playbook = { id: id('pb'), name, enabled: input.enabled !== false, rule, createdAt: now, updatedAt: now };
  await repo.insertPlaybook(p);
  await repo.writeAudit({ actorRepId, action: 'settings.playbook', targetRepId: null, path: '/api/admin/playbooks', detail: { id: p.id, name, trigger: rule.trigger.kind, created: true } });
  return p;
}

export async function updatePlaybook(repo: Repo, playbookId: string, input: { name?: unknown; enabled?: unknown; rule?: unknown }, actorRepId: string): Promise<Playbook> {
  const existing = (await repo.listPlaybooks()).find((p) => p.id === playbookId);
  if (!existing) throw new HttpError(404, 'Playbook not found');
  const patch: Partial<Pick<Playbook, 'name' | 'enabled' | 'rule'>> = {};
  if (input.name !== undefined) {
    const name = String(input.name ?? '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Give the playbook a name');
    patch.name = name;
  }
  if (input.enabled !== undefined) patch.enabled = !!input.enabled;
  if (input.rule !== undefined) {
    try {
      patch.rule = normalizeRule(input.rule);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'Invalid rule');
    }
  }
  await repo.updatePlaybook(playbookId, patch);
  await repo.writeAudit({ actorRepId, action: 'settings.playbook', targetRepId: null, path: `/api/admin/playbooks/${playbookId}`, detail: { ...patch, rule: patch.rule ? patch.rule.trigger.kind : undefined } });
  return { ...existing, ...patch, updatedAt: new Date().toISOString() };
}

export async function deletePlaybook(repo: Repo, playbookId: string, actorRepId: string): Promise<void> {
  const existing = (await repo.listPlaybooks()).find((p) => p.id === playbookId);
  if (!existing) throw new HttpError(404, 'Playbook not found');
  await repo.deletePlaybook(playbookId);
  await repo.writeAudit({ actorRepId, action: 'settings.playbook', targetRepId: null, path: `/api/admin/playbooks/${playbookId}`, detail: { name: existing.name, deleted: true } });
}

/** Three rules every MCA shop wants on day one. Inserted once, when there are none; the admin edits or deletes from there. */
export const STARTER_PLAYBOOKS: Array<{ name: string; rule: PlaybookRule }> = [
  {
    name: 'Halfway paid in — renewal call',
    rule: {
      trigger: { kind: 'paidInPct', atLeast: 50 },
      filters: {},
      actions: [
        { kind: 'task', title: 'Call {{merchant}} about a renewal ({{paidIn}} paid in)', dueInDays: 3 },
        { kind: 'emailRep', subject: '{{merchant}} is {{paidIn}} paid in — time to talk renewal', body: 'Hi {{rep.first}},\n\n{{merchant}} ({{lender}}, {{funded}} funded {{fundedDate}}) is {{paidIn}} paid in. Estimated renewal commission if they re-up at the same size: {{estCommission}}.\n\nGive {{contact}} a call this week and log the outcome on your dashboard.\n\n{{link}}' },
      ],
      repeatDays: 14,
    },
  },
  {
    name: 'LOC with unused line — offer a draw',
    rule: {
      trigger: { kind: 'locUnused', atLeast: 10_000 },
      filters: {},
      actions: [{ kind: 'task', title: '{{merchant}} has {{unusedLine}} unused on their line — offer a draw', dueInDays: 5 }],
      repeatDays: 30,
    },
  },
  {
    name: 'Three weeks to maturity — refinance',
    rule: {
      trigger: { kind: 'daysToMaturity', atMost: 21 },
      filters: {},
      actions: [
        { kind: 'task', title: '{{merchant}} matures in {{daysToMaturity}} days — refinance conversation', dueInDays: 2 },
        { kind: 'emailAdmins', subject: '{{merchant}} matures in {{daysToMaturity}} days', body: '{{merchant}} ({{lender}}, {{funded}}) matures in {{daysToMaturity}} days. {{rep.name}} owns the call. Stage: {{stage}}.' },
      ],
      repeatDays: null,
    },
  },
];

const SEED_KEY = 'playbooks.seeded';

export async function ensureStarterPlaybooks(repo: Repo): Promise<number> {
  if (await repo.getSetting<boolean>(SEED_KEY)) return 0;
  const existing = await repo.listPlaybooks();
  let n = 0;
  if (existing.length === 0) {
    const now = new Date().toISOString();
    for (const s of STARTER_PLAYBOOKS) {
      await repo.insertPlaybook({ id: id('pb'), name: s.name, enabled: true, rule: s.rule, createdAt: now, updatedAt: now });
      n++;
    }
  }
  await repo.putSetting(SEED_KEY, true);
  return n;
}

/* ---------- Scheduler ---------- */

const LAST_RUN_KEY = 'playbooks.lastRun';

/** Once a day after the hour in Settings › Portal (playbookHourUtc); a restart never re-runs the same day. */
export function startPlaybookScheduler(deps: PlaybookDeps, now = () => new Date()): { stop: () => void; tick: () => Promise<boolean> } {
  const tick = async (): Promise<boolean> => {
    const at = now();
    const s = await deps.repo.getSettings();
    if (at.getUTCHours() < s.notifications.playbookHourUtc) return false;
    const today = at.toISOString().slice(0, 10);
    const last = await deps.repo.getSetting<string>(LAST_RUN_KEY);
    if (last === today) return false;
    await deps.repo.putSetting(LAST_RUN_KEY, today);
    await ensureStarterPlaybooks(deps.repo);
    await runPlaybooks(deps, today);
    return true;
  };
  const timer = setInterval(() => void tick().catch((e) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', playbooks: String(e) }))), 15 * 60 * 1000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}

/* ---------- Tasks ---------- */

export interface TaskView extends RepTask {
  business: string;
  lender: string;
  funded: number;
  repName: string;
  playbookName: string | null;
  overdue: boolean;
  merchantContact: string;
  merchantPhone: string;
  merchantEmail: string;
}

export async function taskViews(repo: Repo, filter: { repId?: string; dealId?: string; status?: RepTask['status'] }, today: string): Promise<TaskView[]> {
  const [tasks, ctx, reps, playbooks] = await Promise.all([repo.listTasks(filter), repo.loadContext(), repo.listReps(), repo.listPlaybooks()]);
  const deal = new Map(ctx.deals.map((d) => [d.id, d]));
  const rep = new Map(reps.map((r) => [r.id, r.name]));
  const pb = new Map(playbooks.map((p) => [p.id, p.name]));
  return tasks
    .map((t) => {
      const d = deal.get(t.dealId);
      return { ...t, business: d?.business ?? t.dealId, lender: d?.lender ?? '', funded: d ? totalFunded(d) : 0, repName: rep.get(t.repId) ?? t.repId, playbookName: t.playbookId ? pb.get(t.playbookId) ?? null : null, overdue: t.status === 'open' && t.dueDate < today, merchantContact: d?.merchantContact ?? '', merchantPhone: d?.merchantPhone ?? '', merchantEmail: d?.merchantEmail ?? '' };
    })
    .sort((a, b) => (a.status === b.status ? a.dueDate.localeCompare(b.dueDate) : a.status === 'open' ? -1 : 1));
}

export async function createTask(repo: Repo, input: { dealId: string; repId?: unknown; title?: unknown; dueDate?: unknown }, actorRepId: string, today: string): Promise<RepTask> {
  const ctx = await repo.loadContext();
  const d = ctx.deals.find((x) => x.id === input.dealId);
  if (!d) throw new HttpError(404, 'Deal not found');
  const repId = String(input.repId ?? d.closerId ?? d.openerId ?? actorRepId);
  const title = String(input.title ?? '').trim().slice(0, 160);
  if (!title) throw new HttpError(400, 'What should be done?');
  const dueDate = String(input.dueDate ?? addDays(today, 3));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new HttpError(400, 'Due date must be YYYY-MM-DD');
  const t: RepTask = { id: id('task'), dealId: d.id, repId, playbookId: null, title, dueDate, status: 'open', outcome: null, note: null, createdBy: actorRepId, createdAt: new Date().toISOString(), doneAt: null };
  await repo.insertTask(t);
  await repo.writeAudit({ actorRepId, action: 'task', targetRepId: repId, path: `/deals/${d.id}/tasks`, detail: { taskId: t.id, title, dueDate, created: true } });
  return t;
}

/**
 * Log an outcome. Final outcomes close the task (and stop the rule for this
 * deal); "called" / "no answer" keep it open and push the due date out.
 */
export async function logOutcome(repo: Repo, taskId: string, input: { outcome?: unknown; note?: unknown; dueDate?: unknown }, actorRepId: string, today: string, opts: { asAdmin: boolean }): Promise<RepTask> {
  const t = (await repo.listTasks()).find((x) => x.id === taskId);
  if (!t) throw new HttpError(404, 'Task not found');
  if (!opts.asAdmin && t.repId !== actorRepId) throw new HttpError(404, 'Task not found');
  const outcome = input.outcome === undefined || input.outcome === null || input.outcome === '' ? null : (String(input.outcome) as TaskOutcome);
  const def = outcome ? TASK_OUTCOMES.find((o) => o.value === outcome) : undefined;
  if (outcome && !def) throw new HttpError(400, `Outcome must be one of: ${TASK_OUTCOMES.map((o) => o.value).join(', ')}`);
  const note = input.note === undefined ? t.note : String(input.note ?? '').trim().slice(0, 1000) || null;
  const patch: Partial<Pick<RepTask, 'status' | 'outcome' | 'note' | 'doneAt' | 'dueDate'>> = { note };
  if (def) {
    patch.outcome = outcome;
    if (def.closes) {
      patch.status = 'done';
      patch.doneAt = new Date().toISOString();
    } else {
      patch.dueDate = input.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate)) ? String(input.dueDate) : addDays(today, 2);
    }
  } else if (input.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate))) patch.dueDate = String(input.dueDate);
  await repo.updateTask(taskId, patch);
  if (note && outcome) {
    const reps = await repo.listReps();
    const who = reps.find((r) => r.id === actorRepId)?.name ?? actorRepId;
    await repo.insertNote({ id: id('note'), dealId: t.dealId, authorRepId: actorRepId, body: `[${def!.label}] ${note}`, createdAt: new Date().toISOString() });
    await repo.writeAudit({ actorRepId, action: 'deal.note', targetRepId: null, path: `/tasks/${taskId}`, detail: { taskId, outcome, by: who } });
  }
  await repo.writeAudit({ actorRepId, action: 'task', targetRepId: t.repId, path: `/tasks/${taskId}`, detail: { taskId, outcome, status: patch.status ?? t.status, dueDate: patch.dueDate } });
  return { ...t, ...patch };
}

/* ---------- Merchant emails from the rep ---------- */

export interface MerchantTemplate { id: string; name: string; subject: string; body: string }

export const TEMPLATE_DEFAULTS: { merchant: MerchantTemplate[] } = {
  merchant: [
    { id: 'renewal', name: 'Renewal check-in', subject: 'Quick check-in on {{merchant}}', body: 'Hi {{contact}},\n\nYou are {{paidIn}} through your current funding with {{lender}}, which means you may already qualify for additional capital — often at better terms than the first round.\n\nWould a short call this week work to go over the numbers? No paperwork needed to get a quote.\n\nBest,\n{{rep.name}}\n{{company}}' },
    { id: 'draw', name: 'Unused line of credit', subject: 'You still have {{unusedLine}} available', body: 'Hi {{contact}},\n\nA reminder that {{merchant}} still has {{unusedLine}} available on the line with {{lender}}. Draws usually fund in a day or two if you need working capital for payroll, inventory or a slow month.\n\nHappy to walk through it whenever suits you.\n\nBest,\n{{rep.name}}\n{{company}}' },
  ],
};

/** A template rendered for one deal, so the rep can read it before sending. */
export async function merchantPreview(repo: Repo, deal: Deal, repId: string, templateId: string, today: string, appName: string): Promise<{ to: string; subject: string; body: string; template: MerchantTemplate }> {
  const [ctx, reps, settings, notes] = await Promise.all([repo.loadContext(), repo.listReps(), repo.getSettings(), repo.listAllNotes()]);
  const template = settings.templates.merchant.find((t) => t.id === templateId);
  if (!template) throw new HttpError(404, 'Template not found');
  const f = dealFacts({ ...ctx, deals: [deal] }, reps, settings, notes, today)[0]!;
  const rep = reps.find((r) => r.id === repId);
  const fields = mergeFields(f, { link: '', repName: rep?.name, company: settings.portal.company || appName });
  return { to: deal.merchantEmail, subject: renderTemplate(template.subject, fields), body: renderTemplate(template.body, fields), template };
}

export async function sendMerchantEmail(deps: PlaybookDeps, deal: Deal, repId: string, input: { templateId?: unknown; subject?: unknown; body?: unknown }, today: string): Promise<{ ok: true; to: string }> {
  const { repo, mailer } = deps;
  if (!mailer.live && mailer.kind !== 'log') throw new HttpError(503, 'Email is not set up on this portal (MAIL_PROVIDER)');
  const to = deal.merchantEmail.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, 'This deal has no merchant email — add one under contact details first');
  const rep = await repo.findRep(repId);
  if (!rep) throw new HttpError(404, 'Rep not found');
  const base = input.templateId ? await merchantPreview(repo, deal, repId, String(input.templateId), today, deps.appName) : null;
  const subject = String(input.subject ?? base?.subject ?? '').trim().slice(0, 200);
  const body = String(input.body ?? base?.body ?? '').trim().slice(0, 6000);
  if (!subject || !body) throw new HttpError(400, 'Subject and body are required');
  const r = await mailer.send({ to, subject, text: body, replyTo: rep.email });
  await repo.writeAudit({ actorRepId: repId, action: 'mail.merchant', targetRepId: null, path: `/api/me/deals/${deal.id}/merchant-email`, detail: { to, subject, template: base?.template.id ?? null, ok: r.ok, ...(r.error ? { error: r.error } : {}) } });
  if (!r.ok) throw new HttpError(502, `The email could not be sent: ${r.error ?? 'mail provider error'}`);
  await repo.insertNote({ id: id('note'), dealId: deal.id, authorRepId: repId, body: `[Emailed merchant] ${subject}`, createdAt: new Date().toISOString() });
  return { ok: true, to };
}

export async function saveTemplates(repo: Repo, input: { merchant?: unknown }, actorRepId: string): Promise<{ merchant: MerchantTemplate[] }> {
  const list = Array.isArray(input.merchant) ? (input.merchant as Array<Record<string, unknown>>) : [];
  const merchant: MerchantTemplate[] = [];
  for (const t of list) {
    const name = String(t.name ?? '').trim().slice(0, 80);
    const subject = String(t.subject ?? '').trim().slice(0, 200);
    const body = String(t.body ?? '').trim().slice(0, 6000);
    if (!name || !subject || !body) throw new HttpError(400, 'Every template needs a name, a subject and a body');
    const tid = String(t.id ?? '').trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || id('tpl');
    if (merchant.some((m) => m.id === tid)) throw new HttpError(400, `Two templates share the id "${tid}"`);
    merchant.push({ id: tid, name, subject, body });
  }
  await repo.putSetting('templates', { merchant });
  await repo.writeAudit({ actorRepId, action: 'settings.update', targetRepId: null, path: '/api/admin/settings/templates', detail: { merchant: merchant.length } });
  return { merchant };
}
