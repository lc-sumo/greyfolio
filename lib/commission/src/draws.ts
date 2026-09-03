import { commissionFor } from './commission.js';
import type { Deal, DealDraw, ReferralPartner, SegmentKey, WeeklySchedule } from './types.js';

export interface NewDrawInput {
  amount: number;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Overrides the deal's subsequent-draw rate when given. */
  commRate?: number;
  partner?: ReferralPartner | null;
  referralPaidThisMonth?: number;
  /** A weekly schedule when the lender pays in increments (see README open question #2). */
  schedule?: WeeklySchedule | null;
}

/**
 * Price a new draw on a multi-draw opportunity at the SUBSEQUENT draw rate.
 * A new draw immediately adds a line to outstanding commission; it carries no
 * PSF or origination fee of its own.
 */
export function newDraw(deal: Deal, input: NewDrawInput): DealDraw {
  const rate = input.commRate ?? deal.drawSubsequentPct ?? 0;
  if (!(input.amount > 0)) throw new Error('Enter a draw amount');
  if (!(rate > 0)) throw new Error(`${deal.id} has no subsequent draw rate`);
  const n = (deal.draws?.length ?? 0) + 1;
  const calc = commissionFor({
    amount: input.amount,
    basis: 'draw',
    commissionRate: rate,
    referralRate: input.partner ? input.partner.pct : deal.referralRate,
    referralCap: input.partner ? input.partner.monthlyCap : null,
    referralPaidThisMonth: input.referralPaidThisMonth,
  });
  return {
    n,
    ref: `D${n}` as SegmentKey,
    date: input.date,
    amount: input.amount,
    commRate: rate,
    gross: calc.gross,
    referralFee: calc.referralFee,
    net: calc.net,
    collected: input.schedule ? null : 0,
    schedule: input.schedule ?? null,
  };
}
