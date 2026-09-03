/** Admin payroll projections. Never served to reps. */
import {
  clawbackQueue,
  collectionLabel,
  outstandingOf,
  paidFigures,
  payableLines,
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

export interface PayableLineView {
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
  amount: number;
  lenderPaidLabel: string;
  collected: boolean;
}

export function payableFor(ctx: LedgerContext, repId: string): PayableLineView[] {
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  return payableLines(ctx.deals, ctx.lines, repId)
    .map((l) => {
      const d = byId.get(l.dealId)!;
      return {
        key: l.key,
        dealId: l.dealId,
        segmentKey: l.segmentKey,
        segmentLabel: l.segmentLabel,
        business: d.business,
        merchantContact: d.merchantContact,
        merchantEmail: d.merchantEmail,
        merchantPhone: d.merchantPhone,
        lender: d.lender,
        funded: l.segment.amount,
        role: l.role,
        rate: l.rate,
        amount: l.amount,
        lenderPaidLabel: collectionLabel(l.segment),
        collected: outstandingOf(l.segment) === 0,
      };
    })
    .sort((a, b) => b.dealId.localeCompare(a.dealId, undefined, { numeric: true }) || a.segmentKey.localeCompare(b.segmentKey));
}

export interface PayrollRepDetail {
  rep: { id: string; name: string; active: boolean };
  lines: PayableLineView[];
  clawbacks: Array<{ id: string; dealId: string; business: string; date: string; remaining: number }>;
  outstandingClawback: number;
  paidInRun: Array<{ key: string; dealId: string; business: string; merchantContact: string; role: string; segmentKey: string | null; amount: number; paidAt: string }>;
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
      .map((l) => ({ key: l.key, dealId: l.dealId, business: byId.get(l.dealId)?.business ?? '—', merchantContact: byId.get(l.dealId)?.merchantContact ?? '—', role: l.role, segmentKey: l.segmentKey, amount: l.amount, paidAt: l.paidAt }))
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
