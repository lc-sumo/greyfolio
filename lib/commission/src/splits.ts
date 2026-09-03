import { cents, sum } from './money.js';
import { segments } from './segments.js';
import type { Deal, PayoutLine, Rep, Role, Segment, SegmentKey, Team } from './types.js';

/** Idempotency key for one role on one segment. */
export function lineKey(dealId: string, role: Role, sk: SegmentKey): string {
  return `${dealId}|${role}|${sk}`;
}

/** The rep and rate a deal assigns to each role. */
export function roleAssignments(deal: Deal): Array<{ role: Role; repId: string | null; rate: number }> {
  return [
    { role: 'Opener', repId: deal.openerId, rate: deal.openerRate },
    { role: 'Closer', repId: deal.closerId, rate: deal.closerRate },
    { role: 'Override', repId: deal.overrideId, rate: deal.overrideRate },
  ];
}

/** One role on one segment — the unit payroll pays. */
export interface RepLine {
  key: string;
  dealId: string;
  segmentKey: SegmentKey;
  segmentLabel: string;
  role: Role;
  repId: string;
  rate: number;
  amount: number;
  segment: Segment;
}

/**
 * Every earned line on a deal: one per assigned role per segment, priced as
 * `segment.net × rate`. Zero-amount lines are omitted — there is nothing to pay.
 */
export function dealLines(deal: Deal): RepLine[] {
  const out: RepLine[] = [];
  const roles = roleAssignments(deal).filter((r): r is { role: Role; repId: string; rate: number } => !!r.repId);
  for (const seg of segments(deal)) {
    for (const r of roles) {
      const amount = cents(seg.net * r.rate);
      if (amount <= 0) continue;
      out.push({
        key: lineKey(deal.id, r.role, seg.sk),
        dealId: deal.id,
        segmentKey: seg.sk,
        segmentLabel: seg.label,
        role: r.role,
        repId: r.repId,
        rate: r.rate,
        amount,
        segment: seg,
      });
    }
  }
  return out;
}

/** The lines on a deal that belong to one rep (a rep can hold several roles). */
export function repLines(deal: Deal, repId: string): RepLine[] {
  return dealLines(deal).filter((l) => l.repId === repId);
}

/** A rep's total share of a deal's net commission. */
export function repShare(deal: Deal, repId: string): number {
  return sum(repLines(deal, repId).map((l) => l.amount));
}

/** Total payout to all reps on a deal — the denominator for clawback pro-rating. */
export function totalRepPayout(deal: Deal): number {
  return sum(dealLines(deal).map((l) => l.amount));
}

export function houseNet(deal: Deal): number {
  return cents(sum(segments(deal).map((s) => s.net)) - totalRepPayout(deal));
}

export function isRepOnDeal(deal: Deal, repId: string): boolean {
  return deal.openerId === repId || deal.closerId === repId || deal.overrideId === repId;
}

export function repDeals(deals: Deal[], repId: string): Deal[] {
  return deals.filter((d) => isRepOnDeal(d, repId));
}

/** Keys of positive ledger rows — what has been settled. */
export function paidKeys(lines: PayoutLine[]): Set<string> {
  const s = new Set<string>();
  for (const l of lines) if (l.amount > 0) s.add(l.key);
  return s;
}

/** Earned lines not yet in the ledger. */
export function payableLines(deals: Deal[], lines: PayoutLine[], repId?: string): RepLine[] {
  const paid = paidKeys(lines);
  const out: RepLine[] = [];
  for (const d of deals) {
    for (const l of dealLines(d)) {
      if (repId && l.repId !== repId) continue;
      if (!paid.has(l.key)) out.push(l);
    }
  }
  return out;
}

/** True once every earned line on every segment of the deal is settled. */
export function isDealFullyPaid(deal: Deal, lines: PayoutLine[]): boolean {
  const all = dealLines(deal);
  if (all.length === 0) return false;
  const paid = paidKeys(lines);
  return all.every((l) => paid.has(l.key));
}

/**
 * Default rates for a new deal from the rep profiles. The override rep
 * defaults from the opener's team leader; the override rate from that rep's
 * profile, falling back to the team's rate.
 */
export function defaultSplits(
  opener: Rep | null,
  closer: Rep | null,
  reps: Rep[],
  teams: Team[],
): { openerRate: number; closerRate: number; overrideId: string | null; overrideRate: number } {
  const team = opener?.teamId ? teams.find((t) => t.id === opener.teamId) ?? null : null;
  const leader = team?.leaderRepId ? reps.find((r) => r.id === team.leaderRepId) ?? null : null;
  const overrideId = leader && leader.id !== opener?.id && leader.id !== closer?.id ? leader.id : null;
  const overrideRate = overrideId ? (leader?.overrideRate ?? team?.overrideRate ?? 0) : 0;
  return {
    openerRate: opener?.openerRate ?? 0,
    closerRate: closer?.closerRate ?? 0,
    overrideId,
    overrideRate,
  };
}

/**
 * Invariant #9 — three different option lists:
 *  - new-deal assignment → active reps only
 *  - editing splits on an existing deal → all reps, inactive suffixed
 *  - admin View-as → all reps
 */
export function repOptions(reps: Rep[], purpose: 'assign' | 'edit' | 'view-as'): Array<{ id: string; label: string }> {
  const list = purpose === 'assign' ? reps.filter((r) => r.active) : reps;
  return list.map((r) => ({ id: r.id, label: r.active || purpose === 'assign' ? r.name : `${r.name} (inactive)` }));
}
