/**
 * Bookkeeping views: money owed in every direction.
 *  - receivables: what lenders still owe the house, aged
 *  - partner payables: referral fees owed to partners, with a mark-paid action
 *  - cash view: month by month, accrual (earned by funded month) beside cash (rep payouts by paid date)
 *  - exceptions: the things a bookkeeper would otherwise find by reading every row
 * Pure over the ledger context; the routes and the demo share it.
 */
import {
  cents,
  clawbackWindow,
  collectedGross,
  dealCommissionStatus,
  outstandingGross,
  collectedOf,
  outstandingOf,
  renewalOf,
  scheduleEvents,
  segmentOf,
  segments,
  standingLines,
  sum,
  totalFunded,
  totalGross,
  totalRepPayout,
  type Deal,
  type LedgerContext,
  type Rep,
  type SegmentKey,
} from '@greystone/commission';
import { HttpError } from '../http-error.js';
import { payableFor } from '../payroll-views.js';
import type { Repo, Settings } from '../repo.js';
import { setCollection } from './deals.js';
import { daysBetween } from './playbook-rules.js';

export type AgeBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';
export const AGE_BUCKETS: AgeBucket[] = ['current', '1-30', '31-60', '61-90', '90+'];

export interface ReceivableRow {
  dealId: string;
  /** Which segment and, on a schedule, which receipt — what "Received" posts back. */
  segmentKey: SegmentKey;
  event: { kind: 'upfront' | 'increment' | 'remainder'; n: number } | null;
  business: string;
  lender: string;
  product: string;
  fundedDate: string;
  segment: string;
  /** Upfront / Increment 3 / Final / Commission */
  item: string;
  amount: number;
  /** When the lender was expected to pay; from the schedule, or funded + the lender's payment terms. */
  expected: string | null;
  daysOverdue: number;
  bucket: AgeBucket;
}

export interface Receivables {
  asOf: string;
  rows: ReceivableRow[];
  total: number;
  byBucket: Record<AgeBucket, number>;
  byLender: Array<{ lender: string; outstanding: number; overdue: number; termsDays: number; rows: number }>;
}

const bucketOf = (days: number): AgeBucket => (days <= 0 ? 'current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Lender payment terms in days: the lender's own, else Settings › thresholds › payment overdue. */
export function lenderTermsDays(settings: Settings, lender: string): number {
  const l = settings.lenders.find((x) => x.name === lender);
  return l?.paymentTermsDays ?? settings.thresholds.paymentOverdueDays;
}

export function receivables(ctx: LedgerContext, settings: Settings, today: string): Receivables {
  const rows: ReceivableRow[] = [];
  for (const d of ctx.deals) {
    if (d.dealStatus === 'Default') continue; // written off from the receivable list, still visible on the deal
    const terms = lenderTermsDays(settings, d.lender);
    for (const seg of segments(d)) {
      if (outstandingOf(seg) <= 0) continue;
      const events = scheduleEvents(seg, today).filter((e) => !e.received && e.amount > 0);
      if (events.length) {
        for (const e of events) {
          const expected = e.expected;
          const days = expected ? daysBetween(expected, today) : 0;
          rows.push({ dealId: d.id, segmentKey: seg.sk, event: { kind: e.kind, n: e.n }, business: d.business, lender: d.lender, product: d.product, fundedDate: d.date, segment: seg.label, item: e.label, amount: e.amount, expected, daysOverdue: Math.max(0, days), bucket: bucketOf(days) });
        }
      } else {
        const expected = addDays(seg.date, terms);
        const days = daysBetween(expected, today);
        rows.push({ dealId: d.id, segmentKey: seg.sk, event: null, business: d.business, lender: d.lender, product: d.product, fundedDate: d.date, segment: seg.label, item: 'Commission', amount: outstandingOf(seg), expected, daysOverdue: Math.max(0, days), bucket: bucketOf(days) });
      }
    }
  }
  rows.sort((a, b) => b.daysOverdue - a.daysOverdue || b.amount - a.amount);
  const byBucket = Object.fromEntries(AGE_BUCKETS.map((b) => [b, sum(rows.filter((r) => r.bucket === b).map((r) => r.amount))])) as Record<AgeBucket, number>;
  const lenders = new Map<string, ReceivableRow[]>();
  for (const r of rows) lenders.set(r.lender, [...(lenders.get(r.lender) ?? []), r]);
  return {
    asOf: today,
    rows,
    total: sum(rows.map((r) => r.amount)),
    byBucket,
    byLender: [...lenders.entries()].map(([lender, rs]) => ({ lender, outstanding: sum(rs.map((r) => r.amount)), overdue: sum(rs.filter((r) => r.daysOverdue > 0).map((r) => r.amount)), termsDays: lenderTermsDays(settings, lender), rows: rs.length })).sort((a, b) => b.outstanding - a.outstanding),
  };
}

export interface PartnerPayableRow {
  dealId: string;
  business: string;
  lender: string;
  fundedDate: string;
  partner: string;
  fee: number;
  /** Has the house collected the commission this fee comes out of? */
  collected: boolean;
  commissionStatus: string;
  paidAt: string | null;
}

export interface PartnerPayables {
  rows: PartnerPayableRow[];
  partners: Array<{ partner: string; pct: number; owed: number; owedCollected: number; paid: number; deals: number; active: boolean }>;
  totals: { owed: number; owedCollected: number; paid: number };
}

export function partnerPayables(ctx: LedgerContext, settings: Settings): PartnerPayables {
  const isNone = (n: string | null | undefined) => !n || /^none$/i.test(n.trim());
  const rows: PartnerPayableRow[] = ctx.deals
    .filter((d) => !isNone(d.referralPartner))
    .map((d) => {
      const fee = sum(segments(d).map((s) => s.referralFee));
      return { dealId: d.id, business: d.business, lender: d.lender, fundedDate: d.date, partner: d.referralPartner!, fee, collected: dealCommissionStatus(d) === 'YES - Paid In Full', commissionStatus: dealCommissionStatus(d), paidAt: d.referralPaidAt ?? null };
    })
    .filter((r) => r.fee > 0)
    .sort((a, b) => (a.paidAt ? 1 : 0) - (b.paidAt ? 1 : 0) || a.partner.localeCompare(b.partner) || a.fundedDate.localeCompare(b.fundedDate));
  const names = new Set([...rows.map((r) => r.partner), ...settings.partners.map((p) => p.name).filter((n) => !isNone(n))]);
  const partners = [...names]
    .map((partner) => {
      const rs = rows.filter((r) => r.partner === partner);
      const p = settings.partners.find((x) => x.name === partner);
      return { partner, pct: p?.pct ?? 0, owed: sum(rs.filter((r) => !r.paidAt).map((r) => r.fee)), owedCollected: sum(rs.filter((r) => !r.paidAt && r.collected).map((r) => r.fee)), paid: sum(rs.filter((r) => r.paidAt).map((r) => r.fee)), deals: rs.length, active: p?.active !== false };
    })
    .filter((p) => p.deals > 0 || p.active)
    .sort((a, b) => b.owed - a.owed || a.partner.localeCompare(b.partner));
  return { rows, partners, totals: { owed: sum(partners.map((p) => p.owed)), owedCollected: sum(partners.map((p) => p.owedCollected)), paid: sum(partners.map((p) => p.paid)) } };
}

/** Mark (or unmark, with `paid: false`) referral fees as paid out on the given deals. */
export async function markPartnerPaid(repo: Repo, input: { dealIds?: unknown; paid?: unknown; date?: unknown }, actorRepId: string): Promise<{ updated: number; date: string | null }> {
  const ids = Array.isArray(input.dealIds) ? input.dealIds.map(String) : [];
  if (!ids.length) throw new HttpError(400, 'Pick at least one deal');
  const paid = input.paid !== false;
  const date = paid ? String(input.date ?? new Date().toISOString().slice(0, 10)) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Date must be YYYY-MM-DD');
  const ctx = await repo.loadContext();
  let updated = 0;
  for (const id of ids) {
    const d = ctx.deals.find((x) => x.id === id);
    if (!d || !d.referralPartner) continue;
    await repo.updateDeal(id, { referralPaidAt: date });
    updated++;
  }
  await repo.writeAudit({ actorRepId, action: 'deal.referral.paid', targetRepId: null, path: '/api/admin/books/partners/pay', detail: { dealIds: ids, paid, date } });
  return { updated, date };
}

export interface CashMonth {
  month: string;
  deals: number;
  funded: number;
  /** Accrual: gross commission on deals funded this month. */
  grossEarned: number;
  referralFees: number;
  repShares: number;
  /** grossEarned − referralFees − repShares. */
  houseNet: number;
  /** Of this month's gross, how much the lenders have paid so far. */
  collected: number;
  outstanding: number;
  /** Cash: rep payouts dated this month, clawback recoveries netted. */
  repPayouts: number;
  recovered: number;
  repCash: number;
}

export interface CashView {
  year: number;
  months: CashMonth[];
  total: Omit<CashMonth, 'month'>;
}

export function cashView(ctx: LedgerContext, year: number): CashView {
  const months: CashMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, '0')}`;
    const ds = ctx.deals.filter((d) => d.date.startsWith(month));
    const lines = standingLines(ctx.lines).filter((l) => l.paidAt.startsWith(month));
    const grossEarned = sum(ds.map(totalGross));
    const referralFees = sum(ds.flatMap((d) => segments(d).map((s) => s.referralFee)));
    const repShares = sum(ds.map(totalRepPayout));
    const repPayouts = sum(lines.filter((l) => l.amount > 0).map((l) => l.amount));
    const recovered = cents(-sum(lines.filter((l) => l.amount < 0).map((l) => l.amount)));
    months.push({ month, deals: ds.length, funded: sum(ds.map(totalFunded)), grossEarned, referralFees, repShares, houseNet: cents(grossEarned - referralFees - repShares), collected: sum(ds.map(collectedGross)), outstanding: sum(ds.map(outstandingGross)), repPayouts, recovered, repCash: cents(repPayouts - recovered) });
  }
  const keys = ['deals', 'funded', 'grossEarned', 'referralFees', 'repShares', 'houseNet', 'collected', 'outstanding', 'repPayouts', 'recovered', 'repCash'] as const;
  const total = Object.fromEntries(keys.map((k) => [k, k === 'deals' ? months.reduce((s, x) => s + x.deals, 0) : sum(months.map((x) => x[k]))])) as Omit<CashMonth, 'month'>;
  return { year, months, total };
}

const esc = (v: unknown) => { const s = String(v ?? ''); return `"${(/^[=+@\t\r]/.test(s) || /^-(?![\d.])/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };

/**
 * A journal-style CSV QuickBooks (and any bookkeeper) can import: one line
 * per event with a date, account, name, memo and signed amount.
 */
export function booksCsv(ctx: LedgerContext, reps: Rep[], year: number): string {
  const name = new Map(reps.map((r) => [r.id, r.name]));
  const byDeal = new Map(ctx.deals.map((d) => [d.id, d]));
  const rows: Array<[string, string, string, string, string, number]> = [];
  for (const d of ctx.deals.filter((x) => x.date.startsWith(`${year}-`))) {
    const gross = totalGross(d);
    const fee = sum(segments(d).map((s) => s.referralFee));
    if (gross) rows.push([d.date, 'Commission income', d.lender, `${d.id} ${d.business} · ${d.product}`, d.id, gross]);
    if (fee) rows.push([d.referralPaidAt ?? d.date, 'Referral fees', d.referralPartner ?? '', `${d.id} ${d.business}${d.referralPaidAt ? ' · paid' : ' · accrued'}`, d.id, -fee]);
  }
  for (const l of standingLines(ctx.lines).filter((x) => x.paidAt.startsWith(`${year}-`))) {
    const d = byDeal.get(l.dealId);
    rows.push([l.paidAt, l.amount > 0 ? 'Commissions paid to reps' : 'Clawback recovered', name.get(l.repId) ?? l.repId, `${l.dealId} ${d?.business ?? ''} · ${l.role}${l.runId ? ` · ${l.runId}` : ''}`, l.dealId, -l.amount]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const head = ['Date', 'Account', 'Name', 'Memo', 'Deal', 'Amount'].map(esc).join(',');
  return [head, ...rows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5].toFixed(2)].map(esc).join(','))].join('\r\n') + '\r\n';
}

export interface ExceptionItem {
  kind: 'funded-no-commission' | 'paid-before-collected' | 'past-maturity' | 'clawback-closing' | 'overdue-receipt' | 'partner-owed-collected';
  dealId: string;
  business: string;
  lender: string;
  amount: number;
  detail: string;
  /** Sort key: how urgent (days). */
  days: number;
}

export interface Exceptions {
  asOf: string;
  items: ExceptionItem[];
  counts: Record<ExceptionItem['kind'], number>;
  totals: Record<ExceptionItem['kind'], number>;
}

export const EXCEPTION_LABEL: Record<ExceptionItem['kind'], string> = {
  'funded-no-commission': 'Funded, nothing received from the lender',
  'paid-before-collected': 'Reps paid before the lender paid',
  'past-maturity': 'Past maturity, still Performing',
  'clawback-closing': 'Clawback window closes this week',
  'overdue-receipt': 'Lender receipt overdue',
  'partner-owed-collected': 'Partner fee owed on collected commission',
};

export function exceptions(ctx: LedgerContext, settings: Settings, today: string): Exceptions {
  const items: ExceptionItem[] = [];
  const rec = receivables(ctx, settings, today);
  for (const d of ctx.deals) {
    if (d.dealStatus === 'Default' || d.dealStatus === 'Refinanced' || d.dealStatus === 'Paid In Full') continue;
    const terms = lenderTermsDays(settings, d.lender);
    const age = daysBetween(d.date, today);
    const gross = totalGross(d);
    if (gross > 0 && collectedGross(d) === 0 && age > terms) items.push({ kind: 'funded-no-commission', dealId: d.id, business: d.business, lender: d.lender, amount: gross, detail: `Funded ${age} days ago; ${d.lender} pays in ${terms}`, days: age - terms });
    // Reps paid on segments the lender has not fully paid: the house is out of pocket for that difference.
    const paidLines = standingLines(ctx.lines).filter((l) => l.dealId === d.id && l.amount > 0);
    const uncollectedSegs = new Set(segments(d).filter((s) => outstandingOf(s) > 0).map((s) => s.sk));
    const exposed = sum(paidLines.filter((l) => l.segmentKey && uncollectedSegs.has(l.segmentKey)).map((l) => l.amount));
    if (exposed > 0) items.push({ kind: 'paid-before-collected', dealId: d.id, business: d.business, lender: d.lender, amount: exposed, detail: `${money(exposed)} paid to reps; ${money(outstandingGross(d))} still due from ${d.lender}`, days: age });
    const r = renewalOf(d, settings.thresholds, today);
    if (r.maturityDate && r.maturityDate < today && d.dealStatus === 'Performing') items.push({ kind: 'past-maturity', dealId: d.id, business: d.business, lender: d.lender, amount: totalFunded(d), detail: `Matured ${r.maturityDate} — mark Paid In Full, Refinanced or Default`, days: daysBetween(r.maturityDate, today) });
    const cw = clawbackWindow(d, { lender: settings.lenders.find((l) => l.name === d.lender) ?? null, rule: settings.products.find((p) => p.name === d.product) ?? null, defaultDays: settings.thresholds.clawbackWindowDays }, today);
    if (!cw.cleared && cw.daysLeft !== null && cw.daysLeft <= 7) items.push({ kind: 'clawback-closing', dealId: d.id, business: d.business, lender: d.lender, amount: gross, detail: `${cw.label}; clears ${cw.clearsOn}`, days: -(cw.daysLeft ?? 0) });
  }
  for (const row of rec.rows.filter((x) => x.daysOverdue > 0)) items.push({ kind: 'overdue-receipt', dealId: row.dealId, business: row.business, lender: row.lender, amount: row.amount, detail: `${row.item} on ${row.segment}, expected ${row.expected}, ${row.daysOverdue} days late`, days: row.daysOverdue });
  for (const row of partnerPayables(ctx, settings).rows.filter((x) => !x.paidAt && x.collected)) items.push({ kind: 'partner-owed-collected', dealId: row.dealId, business: row.business, lender: row.lender, amount: row.fee, detail: `${money(row.fee)} owed to ${row.partner}; commission collected`, days: daysBetween(row.fundedDate, today) });
  items.sort((a, b) => b.days - a.days);
  const kinds = Object.keys(EXCEPTION_LABEL) as ExceptionItem['kind'][];
  return {
    asOf: today,
    items,
    counts: Object.fromEntries(kinds.map((k) => [k, items.filter((i) => i.kind === k).length])) as Exceptions['counts'],
    totals: Object.fromEntries(kinds.map((k) => [k, sum(items.filter((i) => i.kind === k).map((i) => i.amount))])) as Exceptions['totals'],
  };
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Helper for the playbook engine: deals with an overdue lender receipt. */
export function overdueDealIds(ctx: LedgerContext, settings: Settings, today: string): Set<string> {
  return new Set(receivables(ctx, settings, today).rows.filter((r) => r.daysOverdue > 0).map((r) => r.dealId));
}

export type { Deal };

/* ---------- Receive a lender payment straight from the aging list ---------- */

export interface ReceiveInput {
  dealId?: unknown;
  segmentKey?: unknown;
  /** For incremental lenders: which scheduled receipt landed (upfront, increment n, or the final remainder). */
  event?: { kind?: unknown; n?: unknown } | null;
  /** Dollars received on a plain (non-scheduled) commission; defaults to everything outstanding. */
  amount?: unknown;
  /** The day the money landed; defaults to today. */
  date?: unknown;
}

/**
 * Books › Receivables: "Received" on a row. Lands the lender's payment on the
 * deal through the single collection writer, so the receivable clears, the
 * status re-derives, and the rep's lines become payable — exactly as if it
 * had been recorded from the deal drawer.
 */
export async function receiveLenderPayment(repo: Repo, input: ReceiveInput, actorRepId: string, today: string): Promise<{ dealId: string; segmentKey: SegmentKey; applied: number }> {
  const dealId = String(input.dealId ?? '').trim();
  if (!dealId) throw new HttpError(400, 'dealId is required');
  const segmentKey = String(input.segmentKey ?? 'base') as SegmentKey;
  const date = input.date === undefined || input.date === null || input.date === '' ? today : String(input.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new HttpError(400, 'date must be YYYY-MM-DD');
  if (date > today) throw new HttpError(400, 'A receipt cannot be dated in the future');
  const deal = (await repo.loadContext()).deals.find((d) => d.id === dealId);
  if (!deal) throw new HttpError(404, `Deal ${dealId} not found`);
  const seg = segmentOf(deal, segmentKey);
  if (!seg) throw new HttpError(404, `Segment ${segmentKey} not found on ${dealId}`);
  const before = collectedOf(seg);
  const ev = input.event && typeof input.event === 'object' ? input.event : null;
  if (ev) {
    const kind = String(ev.kind ?? '');
    if (kind === 'upfront') await setCollection(repo, dealId, { segmentKey, markUpfront: true, confirmedDate: date, confirmedSource: 'books' }, actorRepId);
    else if (kind === 'remainder') await setCollection(repo, dealId, { segmentKey, markRemainder: true, confirmedDate: date, confirmedSource: 'books' }, actorRepId);
    else if (kind === 'increment') {
      const n = Number(ev.n);
      const received = seg.schedule?.received ?? 0;
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Increment number is required');
      if (n <= received) throw new HttpError(409, `Increment ${n} is already recorded as received`);
      await setCollection(repo, dealId, { segmentKey, recordWeeks: n - received, confirmedDate: date, confirmedSource: 'books' }, actorRepId);
    } else throw new HttpError(400, 'Unknown receipt kind');
  } else {
    const outstanding = outstandingOf(seg);
    const amount = input.amount === undefined || input.amount === null || input.amount === '' ? outstanding : Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Amount received must be a positive number');
    if (amount > outstanding + 0.005) throw new HttpError(409, `${amount.toFixed(2)} is more than the ${outstanding.toFixed(2)} still outstanding on ${dealId}`);
    await setCollection(repo, dealId, { segmentKey, dollars: cents(before + amount), confirmedDate: date, confirmedSource: 'books' }, actorRepId);
  }
  const after = segmentOf((await repo.loadContext()).deals.find((d) => d.id === dealId)!, segmentKey)!;
  const applied = cents(collectedOf(after) - before);
  await repo.writeAudit({ actorRepId, action: 'deal.collection', targetRepId: null, path: '/api/admin/books/receivables/receive', detail: { dealId, segmentKey, date, applied, event: ev ? { kind: String(ev.kind ?? ''), n: ev.n ?? null } : null } });
  return { dealId, segmentKey, applied };
}

/* ---------- Rep payables, aged ---------- */

export interface RepPayableAgingRow {
  repId: string;
  repName: string;
  dealId: string;
  business: string;
  lender: string;
  role: string;
  segmentKey: string;
  segmentLabel: string;
  /** Unpaid to this rep on this row. */
  amount: number;
  /** The part backed by commission the lender has already paid: payable now. */
  ready: number;
  /** The part still waiting on the lender. */
  waiting: number;
  /** When the obligation began: the day the segment funded. */
  since: string;
  days: number;
  bucket: AgeBucket;
}

export interface RepPayablesAging {
  asOf: string;
  rows: RepPayableAgingRow[];
  total: number;
  ready: number;
  waiting: number;
  byBucket: Record<AgeBucket, number>;
  byRep: Array<{ repId: string; name: string; active: boolean; owed: number; ready: number; oldestDays: number; rows: number }>;
}

/** What the house owes each rep, line by line, aged from the day the deal funded. Ready = the lender has paid, so payroll can run it today. */
export function repPayablesAging(ctx: LedgerContext, reps: Rep[], today: string): RepPayablesAging {
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const rows: RepPayableAgingRow[] = [];
  for (const rep of reps) {
    for (const l of payableFor(ctx, rep.id, today)) {
      const d = byId.get(l.dealId);
      if (!d || l.amount <= 0) continue;
      const seg = segmentOf(d, l.segmentKey as SegmentKey);
      const since = seg?.date ?? d.date;
      const days = Math.max(0, daysBetween(since, today));
      rows.push({ repId: rep.id, repName: rep.name, dealId: l.dealId, business: d.business, lender: d.lender, role: l.role, segmentKey: l.segmentKey, segmentLabel: l.segmentLabel, amount: cents(l.amount), ready: cents(l.collectedAmount), waiting: cents(l.uncollectedAmount), since, days, bucket: bucketOf(days) });
    }
  }
  rows.sort((a, b) => b.days - a.days || b.amount - a.amount);
  const byBucket = Object.fromEntries(AGE_BUCKETS.map((b) => [b, cents(sum(rows.filter((r) => r.bucket === b).map((r) => r.amount)))])) as Record<AgeBucket, number>;
  const byRep = reps
    .map((rep) => {
      const rs = rows.filter((r) => r.repId === rep.id);
      return { repId: rep.id, name: rep.name, active: rep.active, owed: cents(sum(rs.map((r) => r.amount))), ready: cents(sum(rs.map((r) => r.ready))), oldestDays: rs.length ? Math.max(...rs.map((r) => r.days)) : 0, rows: rs.length };
    })
    .filter((x) => x.rows > 0)
    .sort((a, b) => b.owed - a.owed || a.name.localeCompare(b.name));
  return { asOf: today, rows, total: cents(sum(rows.map((r) => r.amount))), ready: cents(sum(rows.map((r) => r.ready))), waiting: cents(sum(rows.map((r) => r.waiting))), byBucket, byRep };
}
