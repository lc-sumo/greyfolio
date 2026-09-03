import { cents, sum } from './money.js';
import { totalNet } from './segments.js';
import { repShare, roleAssignments, totalRepPayout } from './splits.js';
import type { Clawback, Deal, PayoutLine } from './types.js';

export interface RepClawback {
  /** The rep's slice of the deal-level clawback. */
  share: number;
  /** Withheld so far — from negative ledger rows, never a flag. */
  recovered: number;
  /** What still nets against the rep's next payout. */
  remaining: number;
}

/** Negative ledger rows recorded against a clawback. */
export function recoveryLines(lines: PayoutLine[], clawbackId: string, repId?: string): PayoutLine[] {
  const gone = new Set(lines.filter((l) => l.role === 'Void' && l.voids).map((l) => l.voids!));
  return lines.filter(
    (l) => l.role === 'Clawback recovery' && l.clawbackId === clawbackId && l.amount < 0 && !gone.has(l.key) && (!repId || l.repId === repId),
  );
}

/** Dollars recovered against a clawback across every rep — what `clawback.recovered` must equal. */
export function clawbackRecovered(lines: PayoutLine[], clawbackId: string): number {
  return cents(-sum(recoveryLines(lines, clawbackId).map((l) => l.amount)));
}

/**
 * SINGLE definition of one rep's slice of a clawback. Policy: the rep repays
 * their full share of that deal's commission, pro-rata to the amount clawed:
 *
 *   share     = repShare(deal) × clawback.amount / totalNet(deal)
 *   recovered = Σ −(recovery rows for this rep and clawback), capped at share
 *   remaining = share − recovered
 *
 * `remaining` — never the full share — is what nets against the next payout,
 * so a rep is charged exactly once.
 */
export function repClawback(clawback: Clawback, deal: Deal | undefined, repId: string, lines: PayoutLine[]): RepClawback {
  if (!deal || deal.id !== clawback.dealId) return { share: 0, recovered: 0, remaining: 0 };
  const mine = repShare(deal, repId);
  const net = totalNet(deal);
  if (mine <= 0 || net <= 0) return { share: 0, recovered: 0, remaining: 0 };
  const share = cents(mine * (Math.min(clawback.amount, net) / net));
  const recovered = Math.min(share, cents(-sum(recoveryLines(lines, clawback.id, repId).map((l) => l.amount))));
  return { share, recovered, remaining: cents(Math.max(0, share - recovered)) };
}

/** Every rep's slice, for the deal's roles. */
export function clawbackSlices(clawback: Clawback, deal: Deal, lines: PayoutLine[]): Array<{ repId: string } & RepClawback> {
  const seen = new Set<string>();
  const out: Array<{ repId: string } & RepClawback> = [];
  for (const r of roleAssignments(deal)) {
    if (!r.repId || seen.has(r.repId)) continue;
    seen.add(r.repId);
    out.push({ repId: r.repId, ...repClawback(clawback, deal, r.repId, lines) });
  }
  return out;
}

/** Total the reps owe on a clawback (the house absorbs the rest). */
export function clawbackRepTotal(clawback: Clawback, deal: Deal): number {
  const net = totalNet(deal);
  if (net <= 0) return 0;
  return cents(totalRepPayout(deal) * (Math.min(clawback.amount, net) / net));
}

/** A clawback is recovered once every rep slice is withheld. Status is derived, never toggled. */
export function clawbackStatus(clawback: Clawback, deal: Deal, lines: PayoutLine[]): Clawback['status'] {
  const total = clawbackRepTotal(clawback, deal);
  return total > 0 && clawbackRecovered(lines, clawback.id) >= total ? 'recovered' : 'open';
}

export function clawbacksFor(clawbacks: Clawback[], deals: Deal[], repId: string): Clawback[] {
  const byId = new Map(deals.map((d) => [d.id, d]));
  return clawbacks.filter((c) => {
    const d = byId.get(c.dealId);
    return !!d && repShare(d, repId) > 0;
  });
}
