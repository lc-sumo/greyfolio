import { cents, sum } from './money.js';
import { lenderClawbackBase } from './segments.js';
import { roleAssignments } from './splits.js';
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

/** A rep's actual standing recovery, without the display cap applied by `repClawback`. */
export function repClawbackRecovered(lines: PayoutLine[], clawbackId: string, repId: string): number {
  return cents(-sum(recoveryLines(lines, clawbackId, repId).map((l) => l.amount)));
}

/**
 * SINGLE definition of one rep's slice of a clawback. Policy: the rep repays
 * their rate-based share of the lender-paid commission, pro-rata to the
 * amount clawed:
 *
 *   share     = Σ(roleRate) × clawback.amount / lenderClawbackBase(deal)
 *   recovered = Σ −(recovery rows for this rep and clawback), capped at share
 *   remaining = share − recovered
 *
 * `remaining` — never the full share — is what nets against the next payout,
 * so a rep is charged exactly once.
 */
export function repClawback(clawback: Clawback, deal: Deal | undefined, repId: string, lines: PayoutLine[]): RepClawback {
  // Forgiven clawbacks remain available as tombstones so historical recovery
  // rows can still be resolved (notably by Void), but they are never a current
  // rep liability.
  if (clawback.forgivenAt) return { share: 0, recovered: 0, remaining: 0 };
  if (!deal || deal.id !== clawback.dealId) return { share: 0, recovered: 0, remaining: 0 };
  const base = lenderClawbackBase(deal);
  if (base <= 0) return { share: 0, recovered: 0, remaining: 0 };
  const ratio = Math.min(clawback.amount, base) / base;
  // Do not use historic gross-based payout rows here. Those are immutable,
  // whereas a clawback debt is newly attributed only to lender-paid dollars.
  const share = cents(sum(roleAssignments(deal)
    .filter((role) => role.repId === repId && role.rate > 0)
    .map((role) => cents(base * role.rate * ratio))));
  if (share <= 0) return { share: 0, recovered: 0, remaining: 0 };
  const recovered = Math.min(share, repClawbackRecovered(lines, clawback.id, repId));
  return { share, recovered, remaining: cents(Math.max(0, share - recovered)) };
}

/** Standing recoveries that the proposed economics can no longer attribute to their rep. */
export function clawbackRecoveryExcesses(clawback: Clawback, deal: Deal, lines: PayoutLine[]): Array<{ repId: string; recovered: number; share: number }> {
  const repIds = new Set(recoveryLines(lines, clawback.id).map((line) => line.repId));
  return [...repIds].sort().flatMap((repId) => {
    const recovered = repClawbackRecovered(lines, clawback.id, repId);
    const share = repClawback(clawback, deal, repId, lines).share;
    return recovered > share ? [{ repId, recovered, share }] : [];
  });
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
  // Sum the same per-rep (and therefore same per-role rounding) slices that
  // payroll and account 1200 use. This is deliberately not a gross payout
  // reversal: merchant PSF remains in the original payout economics.
  return cents(clawbackSlices(clawback, deal, []).reduce((total, slice) => total + slice.share, 0));
}

/** A clawback is recovered once every rep slice is withheld. Status is derived, never toggled. */
export function clawbackStatus(clawback: Clawback, deal: Deal, lines: PayoutLine[]): Clawback['status'] {
  const total = clawbackRepTotal(clawback, deal);
  return total > 0 && clawbackRecovered(lines, clawback.id) >= total ? 'recovered' : 'open';
}

/** A rep participates in lender clawbacks only when a lender-paid basis and a positive assigned rate exist. */
export function hasLenderClawbackParticipation(deal: Deal, repId: string): boolean {
  const base = lenderClawbackBase(deal);
  return base > 0
    && roleAssignments(deal).some((role) => role.repId === repId && cents(base * role.rate) > 0);
}

export function clawbacksFor(clawbacks: Clawback[], deals: Deal[], repId: string): Clawback[] {
  const byId = new Map(deals.map((d) => [d.id, d]));
  return clawbacks.filter((c) => {
    if (c.forgivenAt) return false;
    const d = byId.get(c.dealId);
    return !!d && hasLenderClawbackParticipation(d, repId);
  });
}
