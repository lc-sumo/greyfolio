/**
 * A rep's private calendar feed (ICS): open tasks on their due dates, and
 * for every live deal they own, the "more capital" date, the renewal mark
 * and the maturity date. Subscribed once in Google/Apple/Outlook, it stays
 * current. The URL carries a secret token; revoking it makes a new one.
 */
import { randomBytes } from 'node:crypto';
import { renewalOf, repDeals, totalFunded, type LedgerContext, type Rep } from '@greystone/commission';
import { HttpError } from '../http-error.js';
import type { Repo, RepTask, Settings } from '../repo.js';

export async function issueCalendarToken(repo: Repo, repId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await repo.setCalendarToken(repId, token);
  await repo.writeAudit({ actorRepId: repId, action: 'rep.calendar', targetRepId: null, path: '/api/me/calendar', detail: { issued: true } });
  return token;
}

export async function revokeCalendarToken(repo: Repo, repId: string): Promise<void> {
  await repo.setCalendarToken(repId, null);
  await repo.writeAudit({ actorRepId: repId, action: 'rep.calendar', targetRepId: null, path: '/api/me/calendar', detail: { revoked: true } });
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (iso: string) => iso.replace(/-/g, '');
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function buildIcs(rep: Rep, ctx: LedgerContext, settings: Settings, tasks: RepTask[], today: string, appName: string): string {
  const events: Array<{ uid: string; date: string; summary: string; description: string }> = [];
  for (const t of tasks.filter((x) => x.status === 'open')) {
    const d = ctx.deals.find((x) => x.id === t.dealId);
    events.push({ uid: `task-${t.id}`, date: t.dueDate, summary: t.title, description: d ? `${d.business} · ${d.lender} · ${money(totalFunded(d))}${d.merchantContact ? ` · ${d.merchantContact}` : ''}${d.merchantPhone ? ` · ${d.merchantPhone}` : ''}` : '' });
  }
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 180 * 86_400_000).toISOString().slice(0, 10);
  const own = repDeals(ctx.deals, rep.id).filter((d) => (d.closerId ?? d.openerId) === rep.id && !['Refinanced', 'Paid In Full', 'Default'].includes(d.dealStatus));
  for (const d of own) {
    const r = renewalOf(d, settings.thresholds, today);
    const who = `${d.business} · ${d.lender} · ${money(totalFunded(d))}`;
    if (r.prospectingDate >= today && r.prospectingDate <= horizon) events.push({ uid: `cap-${d.id}`, date: r.prospectingDate, summary: `${d.business}: eligible for more capital`, description: who });
    if (r.markDate && r.markDate >= today && r.markDate <= horizon) events.push({ uid: `mark-${d.id}`, date: r.markDate, summary: `${d.business}: renewable (${Math.round(settings.thresholds.renewalMark * 100)}% paid in)`, description: `${who} · est. renewal commission ${money(r.estRenewalGross)}` });
    if (r.maturityDate && r.maturityDate >= today && r.maturityDate <= horizon) events.push({ uid: `mat-${d.id}`, date: r.maturityDate, summary: `${d.business}: matures`, description: who });
  }
  const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${esc(appName)}//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(`${appName} · ${rep.name.split(' ')[0]}`)}`];
  for (const e of events) {
    const end = new Date(Date.parse(`${e.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@greystone-portal`, `DTSTAMP:${now}`, `DTSTART;VALUE=DATE:${stamp(e.date)}`, `DTEND;VALUE=DATE:${stamp(end)}`, `SUMMARY:${esc(e.summary)}`, ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []), 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export async function calendarForToken(repo: Repo, token: string, today: string, appName: string): Promise<{ rep: Rep; ics: string }> {
  const rep = token ? await repo.findRepByCalendarToken(token) : null;
  if (!rep || !rep.active) throw new HttpError(404, 'Not found');
  const [ctx, settings, tasks] = await Promise.all([repo.loadContext(), repo.getSettings(), repo.listTasks({ repId: rep.id })]);
  return { rep, ics: buildIcs(rep, ctx, settings, tasks, today, appName) };
}
