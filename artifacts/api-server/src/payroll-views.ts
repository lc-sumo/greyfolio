/** Admin payroll projections. Never served to reps. */
import { clawbackQueue, collectionLabel, paidFigures, standingLines, payableLines, payoutPreview, repLedger, sum, type LedgerContext, type PayrollRun, type Rep, unitsPaid, voidedKeys } from '@greystone/commission';

export interface RunSummary extends PayrollRun {
  /** Σ positive rows in this run. */
  paidGross: number;
  recovered: number;
  cash: number;
  repCount: number;
  lineCount: number;
}

export function runSummary(run: PayrollRun, ctx: LedgerContext): RunSummary {
  const rows = ctx.lines.filter((l) => l.runId === run.id);
  const f = paidFigures(rows, ctx.lines);
  return { ...run, paidGross: f.gross, recovered: f.recovered, cash: f.cash, repCount: new Set(rows.map((l) => l.repId)).size, lineCount: f.lineCount };
}

export interface PayrollRepRow {
  id: string;
  name: string;
  active: boolean;
  owed: number;
  held: number;
  lineCount: number;
}

/** Rep list for the payroll screen, sorted by amount owed. */
export function payrollReps(ctx: LedgerContext, reps: Rep[]): PayrollRepRow[] {
  return reps
    .map((r) => {
      const l = repLedger(ctx, r.id);
      return { id: r.id, name: r.name, active: r.active, owed: l.owed, held: l.held, lineCount: payableLines(ctx.deals, ctx.lines, r.id).length };
    })
    .sort((a, b) => b.owed - a.owed || a.name.localeCompare(b.name));
}

/** One payroll row: a role on a segment, with its unpaid units split by whether the lender has paid them. */
export interface PayableLineView {
  /** Row id (the segment line key); not itself payable when the segment is incremental. */
  key: string;
  dealId: string;
  segmentKey: string;
  segmentLabel: string;
  business: string;
  merchantContact: string;
  merchantEmail: string;
  merchantPhone: string;
  lender: string;
  funded: number;
  role: string;
  rate: number;
  /** Total unpaid on this row (collected + uncollected). */
  amount: number;
  lenderPaidLabel: string;
  /** Everything unpaid on the row is backed by collected commission. */
  collected: boolean;
  /** Ledger keys and amounts for the two halves. */
  collectedKeys: string[];
  collectedAmount: number;
  uncollectedKeys: string[];
  uncollectedAmount: number;
  /** Incremental segments: increments paid to this rep / total units, and how many the lender has paid. */
  units: { paid: number; total: number; collected: number } | null;
}

export function payableFor(ctx: LedgerContext, repId: string, today = new Date().toISOString().slice(0, 10)): PayableLineView[] {
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const groups = new Map<string, ReturnType<typeof payableLines>>();
  for (const l of payableLines(ctx.deals, ctx.lines, repId, today)) {
    const k = `${l.dealId}|${l.role}|${l.segmentKey}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups.entries()]
    .map(([key, ls]) => {
      const first = ls[0]!;
      const d = byId.get(first.dealId)!;
      const coll = ls.filter((l) => l.collected);
      const unc = ls.filter((l) => !l.collected);
      const incremental = !!first.unit;
      const u = incremental ? unitsPaid(d, ctx.lines, repId, first.segmentKey) : null;
      return {
        key,
        dealId: first.dealId,
        segmentKey: first.segmentKey,
        segmentLabel: first.segment.label,
        business: d.business,
        merchantContact: d.merchantContact,
        merchantEmail: d.merchantEmail,
        merchantPhone: d.merchantPhone,
        lender: d.lender,
        funded: first.segment.amount,
        role: first.role,
        rate: first.rate,
        amount: sum(ls.map((l) => l.amount)),
        lenderPaidLabel: collectionLabel(first.segment),
        collected: unc.length === 0,
        collectedKeys: coll.map((l) => l.key),
        collectedAmount: sum(coll.map((l) => l.amount)),
        uncollectedKeys: unc.map((l) => l.key),
        uncollectedAmount: sum(unc.map((l) => l.amount)),
        units: u,
      };
    })
    .sort((a, b) => b.dealId.localeCompare(a.dealId, undefined, { numeric: true }) || a.segmentKey.localeCompare(b.segmentKey));
}

export interface PayrollRepDetail {
  rep: { id: string; name: string; active: boolean };
  lines: PayableLineView[];
  clawbacks: Array<{ id: string; dealId: string; business: string; date: string; remaining: number }>;
  outstandingClawback: number;
  paidInRun: Array<{ key: string; dealId: string; business: string; merchantContact: string; merchantEmail: string; merchantPhone: string; role: string; voided: boolean; voids: string | null; segmentKey: string | null; unitLabel: string | null; amount: number; paidAt: string }>;
  paidSummary: { gross: number; recovered: number; cash: number; lineCount: number };
}

export function payrollRepDetail(ctx: LedgerContext, rep: Rep, runId: string): PayrollRepDetail {
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const queue = clawbackQueue(ctx, rep.id);
  const paid = ctx.lines.filter((l) => l.runId === runId && l.repId === rep.id);
  const gone = voidedKeys(paid);
  return {
    rep: { id: rep.id, name: rep.name, active: rep.active },
    lines: payableFor(ctx, rep.id),
    clawbacks: queue.map((q) => ({ id: q.clawback.id, dealId: q.clawback.dealId, business: byId.get(q.clawback.dealId)?.business ?? q.clawback.dealId, date: q.clawback.date, remaining: q.remaining })),
    outstandingClawback: sum(queue.map((q) => q.remaining)),
    paidInRun: paid
      .map((l) => ({ key: l.key, dealId: l.dealId, business: byId.get(l.dealId)?.business ?? '—', merchantContact: byId.get(l.dealId)?.merchantContact ?? '—', merchantEmail: byId.get(l.dealId)?.merchantEmail ?? '', merchantPhone: byId.get(l.dealId)?.merchantPhone ?? '', role: l.role, segmentKey: l.segmentKey, unitLabel: unitLabelOf(l.role === 'Void' ? (l.voids ?? l.key) : l.key), amount: l.amount, paidAt: l.paidAt, voided: gone.has(l.key), voids: l.voids ?? null }))
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt) || Math.sign(b.amount) - Math.sign(a.amount) || a.key.localeCompare(b.key)),
    paidSummary: paidFigures(paid, ctx.lines),
  };
}

export function preview(ctx: LedgerContext, repId: string, keys: string[]) {
  return payoutPreview(ctx, repId, keys);
}

/** CSV of a run's ledger rows (all reps, or one). */
export function runCsv(ctx: LedgerContext, reps: Rep[], runId: string, repId?: string): string {
  const name = new Map(reps.map((r) => [r.id, r.name]));
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = ctx.lines.filter((l) => l.runId === runId && (!repId || l.repId === repId)).sort((a, b) => a.repId.localeCompare(b.repId) || a.key.localeCompare(b.key));
  const head = ['Run', 'Rep', 'Deal', 'Business', 'Segment', 'Role', 'Amount', 'Paid at', 'Clawback'].map(esc).join(',');
  const body = rows.map((l) => [runId, name.get(l.repId) ?? l.repId, l.dealId, byId.get(l.dealId)?.business ?? '', l.segmentKey ?? '', l.role, l.amount.toFixed(2), l.paidAt, l.clawbackId ?? ''].map(esc).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

/** `F9|Opener|base|u3` → "Increment 3"; `…|u0` → "Upfront"; the highest unit is the final — resolved by the caller when needed. */
export function unitLabelOf(key: string): string | null {
  const m = /\|u(\d+)(?:#\d+)?$/.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return n === 0 ? 'Upfront' : `Increment ${n}`;
}

export interface AnnualRow {
  repId: string;
  name: string;
  email: string;
  active: boolean;
  /** Standing (non-voided) positive rows: what was paid out. */
  grossPaid: number;
  /** Clawback dollars withheld from those payouts. */
  recovered: number;
  /** Cash that actually went to the rep: gross − recovered. */
  cash: number;
  payouts: number;
  deals: number;
}

/** Year-end totals per rep for the accountant (1099s, reconciliation). Based on paid-at dates, like the ledger. */
export function annualReport(ctx: LedgerContext, reps: Rep[], year: number): { year: number; rows: AnnualRow[]; total: Omit<AnnualRow, 'repId' | 'name' | 'email' | 'active'> } {
  const prefix = `${year}-`;
  const rows = reps
    .map((rep) => {
      const mine = ctx.lines.filter((l) => l.repId === rep.id && l.paidAt.startsWith(prefix));
      const f = paidFigures(mine, ctx.lines);
      const standing = standingLines(mine);
      return { repId: rep.id, name: rep.name, email: rep.email, active: rep.active, grossPaid: f.gross, recovered: f.recovered, cash: f.cash, payouts: new Set(standing.map((l) => l.paidAt)).size, deals: new Set(standing.filter((l) => l.amount > 0).map((l) => l.dealId)).size };
    })
    .filter((r) => r.grossPaid > 0 || r.recovered > 0)
    .sort((a, b) => b.cash - a.cash);
  const total = rows.reduce((t, r) => ({ grossPaid: t.grossPaid + r.grossPaid, recovered: t.recovered + r.recovered, cash: t.cash + r.cash, payouts: t.payouts + r.payouts, deals: t.deals + r.deals }), { grossPaid: 0, recovered: 0, cash: 0, payouts: 0, deals: 0 });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { year, rows, total: { ...total, grossPaid: r2(total.grossPaid), recovered: r2(total.recovered), cash: r2(total.cash) } };
}

export function annualCsv(ctx: LedgerContext, reps: Rep[], year: number): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const { rows, total } = annualReport(ctx, reps, year);
  const head = ['Year', 'Rep', 'Email', 'Active', 'Gross paid', 'Clawback recovered', 'Cash paid', 'Payouts', 'Deals'].map(esc).join(',');
  const body = rows.map((r) => [year, r.name, r.email, r.active ? 'yes' : 'no', r.grossPaid.toFixed(2), r.recovered.toFixed(2), r.cash.toFixed(2), r.payouts, r.deals].map(esc).join(','));
  const foot = [year, 'TOTAL', '', '', total.grossPaid.toFixed(2), total.recovered.toFixed(2), total.cash.toFixed(2), total.payouts, total.deals].map(esc).join(',');
  return [head, ...body, foot].join('\r\n') + '\r\n';
}
