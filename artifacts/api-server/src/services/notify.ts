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
import type { PayoutPlan } from '@greystone/commission';
import type { Mail, Mailer } from './mail.js';

export interface NotifyDeps {
  repo: Repo;
  mailer: Mailer;
  /** Where links point, e.g. https://portal.greystoneus.com */
  origin: string;
  appName: string;
}

const money = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Settings override the boot-time defaults: the portal's name in emails, and which emails are on at all. */
async function tuned(deps: NotifyDeps): Promise<{ deps: NotifyDeps; on: NotifyDeps extends never ? never : { statements: boolean; payoutRecorded: boolean; clawbacks: boolean; renewalDigest: boolean; repQuestions: boolean; digestHourUtc: number } }> {
  const s = await deps.repo.getSettings();
  const name = s.portal.company && s.portal.portal ? `${s.portal.company} ${s.portal.portal}` : deps.appName;
  return { deps: { ...deps, appName: name }, on: s.notifications };
}

async function deliver(deps: NotifyDeps, actorRepId: string, targetRepId: string | null, mail: Mail, why: string): Promise<boolean> {
  if (!deps.mailer.live && deps.mailer.kind !== 'log') return false;
  try {
    const r = await deps.mailer.send(mail);
    await deps.repo.writeAudit({ actorRepId, action: 'mail.sent', targetRepId, path: null, detail: { to: mail.to, subject: mail.subject, why, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.id ? { id: r.id } : {}) } });
    return r.ok;
  } catch (error) {
    // Sending is never part of the business transaction. Preserve a useful
    // audit event even when a provider throws rather than returning `{ ok }`.
    await deps.repo.writeAudit({ actorRepId, action: 'mail.sent', targetRepId, path: null, detail: { to: mail.to, subject: mail.subject, why, ok: false, error: error instanceof Error ? error.message : String(error) } });
    return false;
  }
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
export async function notifyRunApproved(deps0: NotifyDeps, runId: string, actorRepId: string): Promise<{ sent: number; reps: number }> {
  const { deps, on } = await tuned(deps0);
  if (!on.statements) return { sent: 0, reps: 0 };
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

/**
 * Receipt for one committed selected payout. This is deliberately called only
 * after the ledger transaction succeeds. Its key is the immutable run/rep/
 * ledger-row identity, so a retried handler cannot send the same receipt.
 */
export async function notifyPayoutRecorded(deps0: NotifyDeps, runId: string, plan: PayoutPlan, actorRepId: string): Promise<{ sent: boolean; duplicate: boolean }> {
  const { deps, on } = await tuned(deps0);
  if (!on.payoutRecorded) return { sent: false, duplicate: false };
  const identity = [runId, plan.repId, ...[...plan.lines, ...plan.recoveries].map((line) => line.key).sort()].join('|');
  const key = `notify.payoutRecorded:${identity}`;
  // Atomically claim the committed event before delivery. A provider failure
  // remains audited and never rolls back the payout, but is intentionally not
  // retried automatically: retries must not produce concurrent duplicates.
  if (!await deps.repo.claimSettingOnce(key, true)) return { sent: false, duplicate: true };
  const [reps, runs, ctx] = await Promise.all([deps.repo.listReps(), deps.repo.listRuns(), deps.repo.loadContext()]);
  const rep = reps.find((r) => r.id === plan.repId);
  const run = runs.find((r) => r.id === runId);
  if (!rep || !rep.active || !run) return { sent: false, duplicate: false };
  const deals = new Map(ctx.deals.map((deal) => [deal.id, deal]));
  const selectedCounts = new Map<string, number>();
  for (const line of plan.lines) selectedCounts.set(line.dealId, (selectedCounts.get(line.dealId) ?? 0) + 1);
  const selected = [...selectedCounts]
    .map(([id, count]) => ({ deal: deals.get(id), count }))
    .filter((row): row is { deal: NonNullable<typeof row.deal>; count: number } => !!row.deal)
    .map(({ deal, count }) => `• ${deal.business} — ${deal.lender} (${count} selected line${count === 1 ? '' : 's'})`)
    .join('\n');
  const text = [
    `Hi ${rep.name.split(' ')[0]},`,
    '',
    `Your selected payout has been recorded for ${run.label}.`,
    '',
    'Selected deals/lines:',
    selected || `• ${plan.lines.length} commission line${plan.lines.length === 1 ? '' : 's'}`,
    '',
    `Gross commission:  ${money(plan.gross)}`,
    `Clawback withheld: ${money(plan.withheld)}`,
    `Net paid:          ${money(plan.net)}`,
    '',
    `See every line: ${deps.origin}/payments`,
    '',
    `— ${deps.appName}`,
  ].join('\n');
  return { sent: await deliver(deps, actorRepId, rep.id, { to: rep.email, subject: `Payout recorded — ${run.label}`, text }, `payout recorded ${identity}`), duplicate: false };
}

/** A clawback was recorded: each rep who earned on the deal hears what their slice is and how it will be netted. */
export async function notifyClawback(deps0: NotifyDeps, clawback: Clawback, actorRepId: string): Promise<{ sent: number }> {
  const { deps, on } = await tuned(deps0);
  if (!on.clawbacks) return { sent: 0 };
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
export async function renewalDigest(deps0: NotifyDeps, today: string): Promise<{ sent: number; deals: number }> {
  const { deps, on } = await tuned(deps0);
  if (!on.renewalDigest) return { sent: 0, deals: 0 };
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
    // Settings › Portal decides the hour (and whether the digest is on at all); the env value is the fallback.
    const s = await deps.repo.getSettings();
    if (!s.notifications.renewalDigest) return false;
    if (at.getUTCHours() < (s.notifications.digestHourUtc ?? hourUtc)) return false;
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

/** A rep's question about one of their deals: a note on the deal (for the history) plus an email to every admin. */
export async function repQuestion(deps0: NotifyDeps, repId: string, dealId: string, text: string): Promise<{ noteId: string; sent: number }> {
  const { deps, on } = await tuned(deps0);
  const [ctx, reps] = await Promise.all([deps.repo.loadContext(), deps.repo.listReps()]);
  const rep = reps.find((r) => r.id === repId);
  const deal = ctx.deals.find((d) => d.id === dealId);
  if (!rep || !deal) throw new Error('Rep or deal not found');
  const body = String(text ?? '').trim();
  const note = { id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, dealId, authorRepId: repId, body: `[Question from ${rep.name}] ${body}`, createdAt: new Date().toISOString() };
  await deps.repo.insertNote(note);
  await deps.repo.writeAudit({ actorRepId: repId, action: 'deal.note', targetRepId: null, path: `/api/me/deals/${dealId}/question`, detail: { noteId: note.id, question: true } });
  const admins = reps.filter((r) => r.active && r.role === 'admin');
  let sent = 0;
  if (admins.length && on.repQuestions) {
    const mail: Mail = { to: admins.map((a) => a.email), subject: `${rep.name} asked about ${deal.business} (${deal.id})`, text: [`${rep.name} sent a question from the portal about ${deal.business} (${deal.id}, ${deal.lender}, funded ${deal.date}):`, '', body, '', `Open the deal: ${deps.origin}/deals`, '', `— ${deps.appName}`].join('\n') };
    if (await deliver(deps, repId, null, mail, `question ${dealId}`)) sent = admins.length;
  }
  return { noteId: note.id, sent };
}
