/** Admin payroll projections. Never served to reps. */
import {
  clawbackQueue,
  collectionLabel,
  paidFigures,
  payableLines,
  unitsPaid,
  payoutPreview,
  repLedger,
  sum,
  type LedgerContext,
  type PayrollRun,
  type Rep,
} from '@greystone/commission';

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
  const f = paidFigures(rows);
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
  paidInRun: Array<{ key: string; dealId: string; business: string; merchantContact: string; role: string; segmentKey: string | null; unitLabel: string | null; amount: number; paidAt: string }>;
  paidSummary: { gross: number; recovered: number; cash: number; lineCount: number };
}

export function payrollRepDetail(ctx: LedgerContext, rep: Rep, runId: string): PayrollRepDetail {
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const queue = clawbackQueue(ctx, rep.id);
  const paid = ctx.lines.filter((l) => l.runId === runId && l.repId === rep.id);
  return {
    rep: { id: rep.id, name: rep.name, active: rep.active },
    lines: payableFor(ctx, rep.id),
    clawbacks: queue.map((q) => ({ id: q.clawback.id, dealId: q.clawback.dealId, business: byId.get(q.clawback.dealId)?.business ?? q.clawback.dealId, date: q.clawback.date, remaining: q.remaining })),
    outstandingClawback: sum(queue.map((q) => q.remaining)),
    paidInRun: paid
      .map((l) => ({ key: l.key, dealId: l.dealId, business: byId.get(l.dealId)?.business ?? '—', merchantContact: byId.get(l.dealId)?.merchantContact ?? '—', role: l.role, segmentKey: l.segmentKey, unitLabel: unitLabelOf(l.key), amount: l.amount, paidAt: l.paidAt }))
      .sort((a, b) => a.paidAt.localeCompare(b.paidAt) || Math.sign(b.amount) - Math.sign(a.amount) || a.key.localeCompare(b.key)),
    paidSummary: paidFigures(paid),
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
  const m = /\|u(\d+)$/.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return n === 0 ? 'Upfront' : `Increment ${n}`;
}
