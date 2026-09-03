import { collectedOf as collectedOfSeg, scheduleEvents } from './collection.js';
import { rowBase, standingLines } from './void.js';
import { cents, sum } from './money.js';
import { segments } from './segments.js';
import type { Deal, PayoutLine, Rep, Role, Segment, SegmentKey, Team } from './types.js';

/** Idempotency key for one role on one segment (whole-segment payout). */
export function lineKey(dealId: string, role: Role, sk: SegmentKey): string {
  return `${dealId}|${role}|${sk}`;
}

/** Idempotency key for one role on one lender receipt of an incremental segment: `F12|Opener|base|u3`. */
export function unitKey(dealId: string, role: Role, sk: SegmentKey, unit: number): string {
  return `${dealId}|${role}|${sk}|u${unit}`;
}

/** The rep and rate a deal assigns to each role. */
export function roleAssignments(deal: Deal): Array<{ role: Role; repId: string | null; rate: number }> {
  return [
    { role: 'Opener', repId: deal.openerId, rate: deal.openerRate },
    { role: 'Closer', repId: deal.closerId, rate: deal.closerRate },
    { role: 'Override', repId: deal.overrideId, rate: deal.overrideRate },
  ];
}

/**
 * The unit payroll pays: one role on one segment — or, when the lender pays
 * that segment in increments, one role on ONE lender receipt (upfront,
 * increment n, or the final). Paying receipt by receipt is how "4 of 20
 * increments paid to the rep" stays a ledger fact.
 */
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
  /** Which lender receipt this unit follows; undefined for a whole-segment line. */
  unit?: { n: number; kind: 'upfront' | 'increment' | 'remainder'; label: string; expected: string | null };
  /** The lender has paid the commission this unit is priced on. */
  collected: boolean;
}

/**
 * Every earned line on a deal: one per assigned role per segment, priced as
 * `segment.gross × rate` — reps are paid on gross commission; the house absorbs the
 * referral fee. Zero-amount lines are omitted — there is nothing to pay.
 */
export function dealLines(deal: Deal, today = '9999-12-31'): RepLine[] {
  const out: RepLine[] = [];
  const roles = roleAssignments(deal).filter((r): r is { role: Role; repId: string; rate: number } => !!r.repId);
  for (const seg of segments(deal)) {
    const events = seg.schedule ? scheduleEvents(seg, today).filter((e) => e.amount > 0) : [];
    for (const r of roles) {
      if (events.length) {
        // Incremental segment: one unit per lender receipt, priced on that receipt's GROSS.
        for (const e of events) {
          const amount = cents(e.amount * r.rate);
          if (amount <= 0) continue;
          out.push({
            key: unitKey(deal.id, r.role, seg.sk, e.n),
            dealId: deal.id,
            segmentKey: seg.sk,
            segmentLabel: `${seg.label} · ${e.label}`,
            role: r.role,
            repId: r.repId,
            rate: r.rate,
            amount,
            segment: seg,
            unit: { n: e.n, kind: e.kind, label: e.label, expected: e.expected },
            collected: e.received,
          });
        }
        continue;
      }
      const amount = cents(seg.gross * r.rate);
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
        collected: outstandingOfSeg(seg) === 0,
      });
    }
  }
  return out;
}

function outstandingOfSeg(seg: Segment): number {
  // local import avoidance: collectedOf lives in collection.ts which imports nothing from here
  return Math.max(0, cents(seg.gross - collectedOfSeg(seg)));
}

/** The lines on a deal that belong to one rep (a rep can hold several roles). */
export function repLines(deal: Deal, repId: string): RepLine[] {
  return dealLines(deal).filter((l) => l.repId === repId);
}

/** A rep's total share of a deal's gross commission. */
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

/**
 * Keys of positive ledger rows — what has been settled. A whole-segment key
 * (`F12|Opener|base`) on a segment that later became incremental counts as
 * every unit of that segment paid, so history never reopens.
 */
export function paidKeys(lines: PayoutLine[]): Set<string> {
  const s = new Set<string>();
  for (const l of standingLines(lines)) if (l.amount > 0) s.add(rowBase(l.key));
  return s;
}

export function isLinePaid(line: Pick<RepLine, 'key' | 'dealId' | 'role' | 'segmentKey'>, paid: Set<string>): boolean {
  return paid.has(line.key) || paid.has(lineKey(line.dealId, line.role, line.segmentKey));
}

/** Earned lines not yet in the ledger. */
export function payableLines(deals: Deal[], lines: PayoutLine[], repId?: string, today?: string): RepLine[] {
  const paid = paidKeys(lines);
  const out: RepLine[] = [];
  for (const d of deals) {
    for (const l of dealLines(d, today)) {
      if (repId && l.repId !== repId) continue;
      if (!isLinePaid(l, paid)) out.push(l);
    }
  }
  return out;
}

/** True once every earned line on every segment of the deal is settled. */
export function isDealFullyPaid(deal: Deal, lines: PayoutLine[]): boolean {
  const all = dealLines(deal);
  if (all.length === 0) return false;
  const paid = paidKeys(lines);
  return all.every((l) => isLinePaid(l, paid));
}

/** How many payable units of a segment each rep has been paid — the "4 of 20 increments paid" figure. */
export function unitsPaid(deal: Deal, lines: PayoutLine[], repId: string, sk: SegmentKey): { paid: number; total: number; collected: number } {
  const paid = paidKeys(lines);
  const mine = dealLines(deal).filter((l) => l.repId === repId && l.segmentKey === sk);
  const byUnit = new Map<number, RepLine[]>();
  for (const l of mine) byUnit.set(l.unit?.n ?? -1, [...(byUnit.get(l.unit?.n ?? -1) ?? []), l]);
  const units = [...byUnit.values()];
  return {
    total: units.length,
    paid: units.filter((ls) => ls.every((l) => isLinePaid(l, paid))).length,
    collected: units.filter((ls) => ls.every((l) => l.collected)).length,
  };
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
