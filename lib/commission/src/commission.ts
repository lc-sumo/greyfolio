import { cents, clamp } from './money.js';
import type { CommissionBasis } from './types.js';

/** Business days per year used for amortizing payback. */
export const BUSINESS_DAYS_PER_YEAR = 252;

export interface PaybackInput {
  amount: number;
  factor?: number | null;
  apr?: number | null;
  termDays?: number | null;
}

/**
 * Payback: `funded × factor` for factor-rate products, or
 * `funded × (1 + apr/100 × termDays/252)` for amortizing products.
 * Falls back to the amount itself when neither is known.
 */
export function paybackOf(input: PaybackInput): number {
  const { amount } = input;
  if (input.factor && input.factor > 0) return cents(amount * input.factor);
  if (input.apr !== null && input.apr !== undefined && input.termDays && input.termDays > 0) {
    return cents(amount * (1 + (input.apr / 100) * (input.termDays / BUSINESS_DAYS_PER_YEAR)));
  }
  return cents(amount);
}

/** Payments per business-day term for each remittance frequency (Mon–Fri only). */
export const PAYMENTS_PER_TERM: Record<string, (termDays: number) => number> = {
  Daily: (t) => t,
  Weekly: (t) => t / 5,
  'Bi-Weekly': (t) => t / 10,
  Monthly: (t) => t / 21,
};

export interface PaymentInput {
  payback: number | null | undefined;
  termDays: number | null | undefined;
  frequency: string | null | undefined;
}

/**
 * The merchant's remittance per period: payback spread evenly over the
 * number of payments the term holds at that frequency. Null when any input
 * is missing — a payment is never guessed.
 */
export function paymentFor(input: PaymentInput): number | null {
  const { payback, termDays } = input;
  if (!payback || !termDays || termDays <= 0) return null;
  const per = PAYMENTS_PER_TERM[input.frequency ?? 'Daily'] ?? PAYMENTS_PER_TERM.Daily!;
  const count = per(termDays);
  if (!(count > 0)) return null;
  return cents(payback / count);
}

export interface ReferralFeeInput {
  gross: number;
  /** Fraction. */
  rate: number;
  /** Monthly cap in dollars; `null`/`undefined` = uncapped. */
  monthlyCap?: number | null;
  /** Fees already paid to this partner in the same calendar month. */
  paidThisMonth?: number;
}

export interface ReferralFee {
  raw: number;
  fee: number;
  capped: boolean;
}

/**
 * `referralFee$ = min(gross$ × referralRate, partner.monthlyCap)`.
 * The cap is per partner per month, so callers may pass what has already
 * been paid this month; with nothing passed it reduces to the README formula.
 */
export function referralFeeFor(input: ReferralFeeInput): ReferralFee {
  const raw = cents(Math.max(0, input.gross) * Math.max(0, input.rate));
  const cap = input.monthlyCap;
  if (cap === null || cap === undefined) return { raw, fee: raw, capped: false };
  const room = Math.max(0, cap - (input.paidThisMonth ?? 0));
  const fee = cents(Math.min(raw, room));
  return { raw, fee, capped: fee < raw };
}

export interface CommissionInput {
  /** Funded amount or draw amount. */
  amount: number;
  basis: CommissionBasis;
  factor?: number | null;
  apr?: number | null;
  termDays?: number | null;
  /** Fraction. */
  commissionRate: number;
  /** Fraction of the basis. */
  psfRate?: number;
  originationFee?: number;
  /** LOC line fee: `lineRate` × `lineAmount` (the credit line) is added to gross. */
  lineAmount?: number | null;
  lineRate?: number | null;
  /** Fraction of gross. */
  referralRate?: number;
  referralCap?: number | null;
  referralPaidThisMonth?: number;
  openerRate?: number;
  closerRate?: number;
  overrideRate?: number;
}

export interface CommissionResult {
  payback: number;
  basisAmount: number;
  commission: number;
  psf: number;
  originationFee: number;
  lineFee: number;
  gross: number;
  referralFeeRaw: number;
  referralFee: number;
  referralCapped: boolean;
  net: number;
  openerPayout: number;
  closerPayout: number;
  overridePayout: number;
  totalRepPayout: number;
  houseNet: number;
}

/**
 * The calculation chain, per segment, in order:
 *
 *   basisAmount   = basis === 'payback' ? payback : amount
 *   commission$   = basisAmount × commissionRate
 *   psf$          = basisAmount × psfRate
 *   gross$        = commission$ + psf$ + originationFee
 *   referralFee$  = min(gross$ × referralRate, partner.monthlyCap)
 *   net$          = gross$ − referralFee$
 *   openerPayout  = gross$ × openerRate   (likewise closer, override) — reps are paid on gross
 *   totalRepPayout= opener + closer + override
 *   houseNet      = net$ − totalRepPayout
 */
export function commissionFor(input: CommissionInput): CommissionResult {
  const amount = Math.max(0, input.amount || 0);
  const payback = paybackOf({ amount, factor: input.factor, apr: input.apr, termDays: input.termDays });
  const basisAmount = input.basis === 'payback' ? payback : amount;

  const commission = cents(basisAmount * clamp(input.commissionRate || 0, 0, 1));
  const psf = cents(basisAmount * clamp(input.psfRate || 0, 0, 1));
  const originationFee = cents(Math.max(0, input.originationFee || 0));
  const lineFee = cents((input.lineAmount ?? 0) * clamp(input.lineRate ?? 0, 0, 1));
  const gross = cents(commission + psf + originationFee + lineFee);

  const ref = referralFeeFor({
    gross,
    rate: clamp(input.referralRate || 0, 0, 1),
    monthlyCap: input.referralCap,
    paidThisMonth: input.referralPaidThisMonth,
  });
  const net = cents(gross - ref.fee);

  const openerPayout = cents(gross * clamp(input.openerRate || 0, 0, 1));
  const closerPayout = cents(gross * clamp(input.closerRate || 0, 0, 1));
  const overridePayout = cents(gross * clamp(input.overrideRate || 0, 0, 1));
  const totalRepPayout = cents(openerPayout + closerPayout + overridePayout);

  return {
    payback,
    basisAmount,
    commission,
    psf,
    lineFee,
    originationFee,
    gross,
    referralFeeRaw: ref.raw,
    referralFee: ref.fee,
    referralCapped: ref.capped,
    net,
    openerPayout,
    closerPayout,
    overridePayout,
    totalRepPayout,
    houseNet: cents(net - totalRepPayout),
  };
}
