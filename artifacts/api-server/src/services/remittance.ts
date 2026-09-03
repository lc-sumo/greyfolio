/**
 * Lender remittance import. Lenders send a weekly report of the commission
 * they paid; this matches each line to a deal and marks what arrived —
 * increments on incremental schedules, dollars collected on everything else —
 * instead of ticking each receipt by hand.
 *
 * CSV shape is loose on purpose: any column that looks like a reference
 * (deal / id / opportunity / business), a date, and an amount.
 */
import { collectedOf, outstandingOf, scheduleEvents, segments, type Deal, type Segment } from '@greystone/commission';
import { isoDate, num, parseCsv } from '@greystone/db/seed/csv';
import { HttpError } from '../http-error.js';
import type { Repo } from '../repo.js';
import { setCollection } from './deals.js';

const today = () => new Date().toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100;

export interface RemittanceStep {
  segmentKey: string;
  /** What `setCollection` will be told. */
  input: Record<string, unknown>;
  label: string;
  amount: number;
}

export interface RemittanceRow {
  line: number;
  ref: string;
  date: string;
  amount: number;
  dealId: string | null;
  business: string | null;
  /** Human plan: "Increments 4–6", "Upfront + increment 1", "$1,200 collected". */
  plan: string;
  steps: RemittanceStep[];
  /** Dollars the plan does not account for (rounding, an overpayment, a schedule already complete). */
  unapplied: number;
  problems: string[];
}

export interface RemittancePreview {
  rows: RemittanceRow[];
  problems: string[];
  summary: { rows: number; matched: number; amount: number; applied: number; unapplied: number; problems: number };
}

const REF = ['deal id', 'deal', 'id', 'opportunity', 'opportunity id', 'crm', 'reference', 'ref', 'merchant', 'business', 'business name', 'client', 'account'];
const DATE = ['date', 'paid', 'paid on', 'payment date', 'received', 'remit date', 'week'];
const AMOUNT = ['amount', 'commission', 'commission paid', 'paid amount', 'total', 'net', 'payment'];

function pickColumns(header: string[]): { ref: number[]; date: number; amount: number } {
  const h = header.map((x) => x.trim().toLowerCase());
  const find = (names: string[]) => {
    for (const n of names) {
      const i = h.indexOf(n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = h.findIndex((x) => x.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const date = find(DATE);
  const amount = find(AMOUNT.filter((a) => a !== 'paid' || date < 0 || h[date] !== 'paid'));
  const ref = REF.map((n) => h.indexOf(n)).filter((i) => i >= 0 && i !== date && i !== amount);
  return { ref: ref.length ? [...new Set(ref)] : h.map((_, i) => i).filter((i) => i !== date && i !== amount).slice(0, 2), date, amount };
}

function findDeal(deals: Deal[], ref: string): { deal: Deal | null; ambiguous: boolean } {
  const r = ref.trim().toLowerCase();
  if (!r) return { deal: null, ambiguous: false };
  const byId = deals.find((d) => d.id.toLowerCase() === r || (d.crmId ?? '').toLowerCase() === r || d.opportunityId.toLowerCase() === r);
  if (byId) return { deal: byId, ambiguous: false };
  const byName = deals.filter((d) => d.business.trim().toLowerCase() === r);
  if (byName.length === 1) return { deal: byName[0]!, ambiguous: false };
  if (byName.length > 1) return { deal: null, ambiguous: true };
  const loose = deals.filter((d) => d.business.toLowerCase().includes(r) || r.includes(d.business.toLowerCase()));
  return loose.length === 1 ? { deal: loose[0]!, ambiguous: false } : { deal: null, ambiguous: loose.length > 1 };
}

/** Which segment this receipt lands on: the first one still owed money, base before draws. */
function targetSegment(deal: Deal): Segment | null {
  return segments(deal).find((s) => outstandingOf(s) > 0.005) ?? null;
}

/**
 * Turn a dollar receipt into collection steps on one segment. Schedules
 * take receipts in order (upfront → increments → remainder) while the running
 * total fits; anything else becomes dollars collected.
 */
export function planReceipt(seg: Segment, amount: number, on: string): { steps: RemittanceStep[]; plan: string; unapplied: number } {
  const tol = Math.max(1, amount * 0.02);
  if (seg.schedule) {
    const pending = scheduleEvents(seg, on).filter((e) => !e.received);
    const steps: RemittanceStep[] = [];
    let sum = 0;
    let weeks = 0;
    let first = 0;
    let last = 0;
    for (const e of pending) {
      if (sum + e.amount > amount + tol) break;
      sum = cents(sum + e.amount);
      if (e.kind === 'upfront') steps.push({ segmentKey: seg.sk, input: { markUpfront: true }, label: 'Upfront', amount: e.amount });
      else if (e.kind === 'increment') {
        weeks++;
        first ||= e.n;
        last = e.n;
      } else steps.push({ segmentKey: seg.sk, input: { markRemainder: true }, label: 'Final', amount: e.amount });
    }
    if (weeks) steps.splice(steps.findIndex((s) => s.label === 'Final') >= 0 ? steps.findIndex((s) => s.label === 'Final') : steps.length, 0, { segmentKey: seg.sk, input: { recordWeeks: weeks }, label: weeks === 1 ? `Increment ${first}` : `Increments ${first}–${last}`, amount: cents(pending.filter((e) => e.kind === 'increment' && e.n >= first && e.n <= last).reduce((s, e) => s + e.amount, 0)) });
    const plan = steps.length ? steps.map((s) => s.label).join(' + ') : pending.length ? `Less than the next receipt (${pending[0]!.label} is ${pending[0]!.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' })})` : 'Schedule already complete';
    return { steps, plan, unapplied: cents(amount - sum) };
  }
  const have = collectedOf(seg);
  const room = cents(Math.max(0, seg.gross - have));
  const take = cents(Math.min(room, amount));
  if (take <= 0) return { steps: [], plan: 'Already collected in full', unapplied: amount };
  return { steps: [{ segmentKey: seg.sk, input: { dollars: cents(have + take) }, label: `${take.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} collected`, amount: take }], plan: `${take.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} collected${take < amount ? ' (rest exceeds gross)' : ''}`, unapplied: cents(amount - take) };
}

export async function previewRemittance(repo: Repo, csv: string): Promise<RemittancePreview> {
  const table = parseCsv(csv).filter((r) => r.some((c) => c.trim()));
  if (table.length < 2) throw new HttpError(400, 'The file needs a header row and at least one payment line');
  const cols = pickColumns(table[0]!);
  const problems: string[] = [];
  if (cols.amount < 0) problems.push('No amount column found (looked for Amount, Commission, Total, Paid)');
  if (cols.date < 0) problems.push('No date column found (Date, Paid, Received) — today will be used');
  const ctx = await repo.loadContext();
  // Simulate in order so two lines for the same deal stack correctly.
  const working = new Map(ctx.deals.map((d) => [d.id, structuredClone(d)]));
  const rows: RemittanceRow[] = [];
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const rowProblems: string[] = [];
    const ref = cols.ref.map((c) => cells[c] ?? '').find((v) => v.trim()) ?? '';
    const amount = cols.amount >= 0 ? num(cells[cols.amount]) : null;
    const date = cols.date >= 0 ? isoDate(cells[cols.date]) : today();
    if (!(amount && amount > 0)) rowProblems.push('Amount must be positive');
    const found = findDeal([...working.values()], ref);
    if (found.ambiguous) rowProblems.push(`"${ref}" matches more than one deal — use the deal id`);
    else if (!found.deal) rowProblems.push(`"${ref}" is not a deal id, CRM id or business on the board`);
    let plan = '';
    let steps: RemittanceStep[] = [];
    let unapplied = amount ?? 0;
    if (found.deal && amount && amount > 0) {
      const seg = targetSegment(found.deal);
      if (!seg) {
        plan = 'Nothing outstanding on this deal';
        rowProblems.push('Every segment on this deal is already collected in full');
      } else {
        const p = planReceipt(seg, amount, date || today());
        plan = seg.sk === 'base' ? p.plan : `${seg.label}: ${p.plan}`;
        steps = p.steps;
        unapplied = p.unapplied;
        if (steps.length === 0) rowProblems.push('Nothing on the schedule fits this amount');
        // Apply to the working copy so the next line for this deal sees it.
        applyToCopy(found.deal, steps);
      }
    }
    rows.push({ line, ref, date: date || today(), amount: amount ?? 0, dealId: found.deal?.id ?? null, business: found.deal?.business ?? null, plan, steps, unapplied, problems: rowProblems });
  });
  const matched = rows.filter((r) => r.dealId && r.problems.length === 0);
  return {
    rows,
    problems,
    summary: {
      rows: rows.length,
      matched: matched.length,
      amount: cents(rows.reduce((s, r) => s + r.amount, 0)),
      applied: cents(matched.reduce((s, r) => s + r.steps.reduce((t, x) => t + x.amount, 0), 0)),
      unapplied: cents(rows.reduce((s, r) => s + (r.problems.length ? 0 : r.unapplied), 0)),
      problems: problems.filter((p) => !p.includes('today will be used')).length + rows.reduce((s, r) => s + r.problems.length, 0),
    },
  };
}

/** Mirror `setCollection` on an in-memory deal so the preview stacks lines correctly. */
function applyToCopy(deal: Deal, steps: RemittanceStep[]): void {
  for (const st of steps) {
    const isBase = st.segmentKey === 'base';
    const sched = isBase ? deal.commSchedule : deal.draws.find((d) => d.ref === st.segmentKey)?.schedule ?? null;
    if ('dollars' in st.input) {
      if (isBase) deal.commCollected = Number(st.input.dollars);
      else deal.draws = deal.draws.map((d) => (d.ref === st.segmentKey ? { ...d, collected: Number(st.input.dollars) } : d));
    } else if (sched) {
      const next = { ...sched };
      if ('markUpfront' in st.input) next.upfrontReceived = true;
      if ('recordWeeks' in st.input) next.received = Math.min(next.weeks, next.received + Number(st.input.recordWeeks));
      if ('markRemainder' in st.input) next.remainderReceived = true;
      if (isBase) deal.commSchedule = next;
      else deal.draws = deal.draws.map((d) => (d.ref === st.segmentKey ? { ...d, schedule: next } : d));
    }
  }
}

export interface RemittanceResult {
  applied: number;
  amount: number;
  deals: string[];
}

/** Apply a clean remittance file. Each step goes through `setCollection`, so the ledger and audit trail see ordinary collection events. */
export async function commitRemittance(repo: Repo, csv: string, actorRepId: string): Promise<RemittanceResult> {
  const preview = await previewRemittance(repo, csv);
  if (preview.summary.problems > 0) throw new HttpError(400, `Fix the ${preview.summary.problems} problem(s) in the preview before applying`);
  let applied = 0;
  const deals = new Set<string>();
  for (const row of preview.rows) {
    if (!row.dealId) continue;
    for (const st of row.steps) {
      await setCollection(repo, row.dealId, { segmentKey: st.segmentKey, ...st.input } as never, actorRepId);
      applied = cents(applied + st.amount);
      deals.add(row.dealId);
    }
  }
  await repo.writeAudit({ actorRepId, action: 'deal.remittance', targetRepId: null, path: '/api/admin/remittance', detail: { lines: preview.rows.length, applied, deals: [...deals] } });
  return { applied, amount: preview.summary.amount, deals: [...deals] };
}
