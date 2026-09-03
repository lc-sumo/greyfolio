/**
 * The emails the portal sends on its own: a rep's statement when a payroll
 * run is approved, a clawback notice when one is recorded against a deal
 * the rep earned on, and a daily renewal digest to admins. Every send is
 * audit-logged; a mailer that is off or fails never blocks the action that
 * triggered it — the caller gets a count back and moves on.
 */
import { clawbackSlices, type Clawback, type Rep } from '@greystone/commission';
import { adminRenewals } from '../admin-views.js';
import type { Repo } from '../repo.js';
import { repStatements } from '../scope.js';
import type { Mail, Mailer } from './mail.js';

export interface NotifyDeps {
  repo: Repo;
  mailer: Mailer;
  /** Where links point, e.g. https://portal.greystoneus.com */
  origin: string;
  appName: string;
}

const money = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function deliver(deps: NotifyDeps, actorRepId: string, targetRepId: string | null, mail: Mail, why: string): Promise<boolean> {
  if (!deps.mailer.live && deps.mailer.kind !== 'log') return false;
  const r = await deps.mailer.send(mail);
  await deps.repo.writeAudit({ actorRepId, action: 'mail.sent', targetRepId, path: null, detail: { to: mail.to, subject: mail.subject, why, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.id ? { id: r.id } : {}) } });
  return r.ok;
}

/** Statement summary for one rep in one run. */
export function statementMail(deps: Pick<NotifyDeps, 'origin' | 'appName'>, rep: Rep, s: { period: string; dealCount: number; grossPaid: number; clawbacks: number; netPaid: number }): Mail {
  const lines = [
    `Hi ${rep.name.split(' ')[0]},`,
    '',
    `Your commission statement for ${s.period} is ready.`,
    '',
    `Deals paid:        ${s.dealCount}`,
    `Gross commission:  ${money(s.grossPaid)}`,
    ...(s.clawbacks ? [`Clawbacks netted:  -${money(s.clawbacks)}`] : []),
    `Net to you:        ${money(s.netPaid)}`,
    '',
    `See every line: ${deps.origin}/payments`,
    '',
    `— ${deps.appName}`,
  ];
  return { to: rep.email, subject: `Statement ready — ${s.period}`, text: lines.join('\n') };
}

/** Called once a run moves to "approved": every rep with lines in it gets their statement. */
export async function notifyRunApproved(deps: NotifyDeps, runId: string, actorRepId: string): Promise<{ sent: number; reps: number }> {
  const [ctx, runs, reps] = await Promise.all([deps.repo.loadContext(), deps.repo.listRuns(), deps.repo.listReps()]);
  const run = runs.find((r) => r.id === runId);
  if (!run) return { sent: 0, reps: 0 };
  let sent = 0;
  let count = 0;
  for (const rep of reps) {
    if (!rep.active) continue;
    const s = repStatements(ctx, [run], rep.id)[0];
    if (!s || s.dealCount === 0) continue;
    count++;
    if (await deliver(deps, actorRepId, rep.id, statementMail(deps, rep, s), `statement ${run.id}`)) sent++;
  }
  return { sent, reps: count };
}

/** A clawback was recorded: each rep who earned on the deal hears what their slice is and how it will be netted. */
export async function notifyClawback(deps: NotifyDeps, clawback: Clawback, actorRepId: string): Promise<{ sent: number }> {
  const [ctx, reps] = await Promise.all([deps.repo.loadContext(), deps.repo.listReps()]);
  const deal = ctx.deals.find((d) => d.id === clawback.dealId);
  if (!deal) return { sent: 0 };
  let sent = 0;
  for (const slice of clawbackSlices(clawback, deal, ctx.lines)) {
    const rep = reps.find((r) => r.id === slice.repId);
    if (!rep || !rep.active || slice.share <= 0) continue;
    const text = [
      `Hi ${rep.name.split(' ')[0]},`,
      '',
      `A clawback of ${money(clawback.amount)} was recorded on ${deal.business} (${deal.lender}, funded ${deal.date}).`,
      `Reason: ${clawback.reason || 'not given'}`,
      '',
      `Your share: ${money(slice.share)}. It nets against your next payout — once, never twice.`,
      '',
      `Details: ${deps.origin}/clawbacks`,
      '',
      `— ${deps.appName}`,
    ].join('\n');
    if (await deliver(deps, actorRepId, rep.id, { to: rep.email, subject: `Clawback recorded — ${deal.business}`, text }, `clawback ${clawback.id}`)) sent++;
  }
  return { sent };
}

/**
 * Daily digest to admins: deals that are renewal-ready or in Prospecting
 * and who is meant to call. Sends nothing on a quiet day.
 */
export async function renewalDigest(deps: NotifyDeps, today: string): Promise<{ sent: number; deals: number }> {
  const [ctx, reps, settings] = await Promise.all([deps.repo.loadContext(), deps.repo.listReps(), deps.repo.getSettings()]);
  const rows = adminRenewals(ctx, reps, settings, today).filter((r) => r.bucket === 'due' || r.bucket === 'prospecting');
  const admins = reps.filter((r) => r.active && r.role === 'admin');
  if (rows.length === 0 || admins.length === 0) return { sent: 0, deals: rows.length };
  const due = rows.filter((r) => r.bucket === 'due');
  const prospecting = rows.filter((r) => r.bucket === 'prospecting');
  const line = (r: (typeof rows)[number]) => `• ${r.business} — ${r.lender}, ${money(r.funded)} funded ${r.date}; ${r.whoCalls} calls; est. renewal gross ${money(r.estRenewalGross)}${r.crmUrl ? `\n  ${r.crmUrl}` : ''}`;
  const text = [
    `Renewal digest for ${today}`,
    '',
    ...(due.length ? [`Refi ready (${due.length}):`, ...due.map(line), ''] : []),
    ...(prospecting.length ? [`Prospecting (${prospecting.length}):`, ...prospecting.map(line), ''] : []),
    `Full list: ${deps.origin}/renewals`,
    '',
    `— ${deps.appName}`,
  ].join('\n');
  const ok = await deliver(deps, admins[0]!.id, null, { to: admins.map((a) => a.email), subject: `Renewals today: ${due.length} ready, ${prospecting.length} prospecting`, text }, `renewal digest ${today}`);
  return { sent: ok ? admins.length : 0, deals: rows.length };
}

const DIGEST_KEY = 'notify.renewalDigestSent';

/**
 * In-process scheduler: checks every 15 minutes and sends the digest once a
 * day after `hourUtc`. State lives in settings, so a restart never re-sends.
 */
export function startDigestScheduler(deps: NotifyDeps, hourUtc: number, now = () => new Date()): { stop: () => void; tick: () => Promise<boolean> } {
  const tick = async (): Promise<boolean> => {
    if (hourUtc < 0 || !deps.mailer.live) return false;
    const at = now();
    if (at.getUTCHours() < hourUtc) return false;
    const today = at.toISOString().slice(0, 10);
    const last = await deps.repo.getSetting<string>(DIGEST_KEY);
    if (last === today) return false;
    await deps.repo.putSetting(DIGEST_KEY, today);
    await renewalDigest(deps, today);
    return true;
  };
  const timer = setInterval(() => void tick().catch((e) => console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', digest: String(e) }))), 15 * 60 * 1000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
