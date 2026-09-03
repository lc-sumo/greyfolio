import { sum } from './money.js';
import type { Deal, DealDraw, Segment } from './types.js';

/**
 * An LOC / consolidation opportunity keeps ONE deal id; every pull is a draw
 * line under it. This returns every commissionable segment of a deal: the
 * initial funding (`base`) followed by each draw (`D1`, `D2`, …) in order.
 */
export function segments(deal: Deal): Segment[] {
  const base: Segment = {
    dealId: deal.id,
    sk: 'base',
    label: 'Initial',
    n: 0,
    date: deal.date,
    amount: deal.funded,
    commRate: deal.commRate,
    gross: deal.gross,
    referralFee: deal.referralFee,
    net: deal.net,
    collected: deal.commCollected,
    schedule: deal.commSchedule,
  };
  const draws = [...(deal.draws ?? [])].sort((a, b) => a.n - b.n);
  return [base, ...draws.map((d) => drawSegment(deal.id, d))];
}

export function drawSegment(dealId: string, d: DealDraw): Segment {
  return {
    dealId,
    sk: d.ref,
    label: `Draw ${d.n}`,
    n: d.n,
    date: d.date,
    amount: d.amount,
    commRate: d.commRate,
    gross: d.gross,
    referralFee: d.referralFee,
    net: d.net,
    collected: d.collected,
    schedule: d.schedule,
  };
}

export function segmentOf(deal: Deal, sk: string): Segment | undefined {
  return segments(deal).find((s) => s.sk === sk);
}

export function totalFunded(deal: Deal): number {
  return sum(segments(deal).map((s) => s.amount));
}

export function totalGross(deal: Deal): number {
  return sum(segments(deal).map((s) => s.gross));
}

/** Net commission across every segment — the base for every rep share. */
export function totalNet(deal: Deal): number {
  return sum(segments(deal).map((s) => s.net));
}
