import { describe, expect, it } from 'vitest';
import { commissionFor, paybackOf, paymentFor, referralFeeFor } from '../src/commission.js';

describe('paybackOf', () => {
  it('uses funded × factor for factor-rate products', () => {
    expect(paybackOf({ amount: 100_000, factor: 1.35 })).toBe(135_000);
  });
  it('uses funded × (1 + apr/100 × termDays/252) for amortizing products', () => {
    expect(paybackOf({ amount: 100_000, factor: null, apr: 12.6, termDays: 252 })).toBe(112_600);
    expect(paybackOf({ amount: 100_000, apr: 10, termDays: 126 })).toBe(105_000);
  });
  it('falls back to the amount when neither is known', () => {
    expect(paybackOf({ amount: 50_000 })).toBe(50_000);
  });
});

describe('referralFeeFor', () => {
  it('is gross × rate when uncapped', () => {
    expect(referralFeeFor({ gross: 12_000, rate: 0.15, monthlyCap: null })).toEqual({ raw: 1800, fee: 1800, capped: false });
  });
  it('applies the partner monthly cap and flags it', () => {
    expect(referralFeeFor({ gross: 200_000, rate: 0.15, monthlyCap: 15_000 })).toEqual({ raw: 30_000, fee: 15_000, capped: true });
  });
  it('honours fees already paid this month against the cap', () => {
    expect(referralFeeFor({ gross: 20_000, rate: 0.15, monthlyCap: 15_000, paidThisMonth: 14_000 })).toEqual({ raw: 3000, fee: 1000, capped: true });
    expect(referralFeeFor({ gross: 20_000, rate: 0.15, monthlyCap: 15_000, paidThisMonth: 15_000 }).fee).toBe(0);
  });
});

describe('commissionFor', () => {
  it('runs the full chain in order', () => {
    const r = commissionFor({
      amount: 100_000,
      basis: 'funded',
      factor: 1.3,
      commissionRate: 0.1,
      psfRate: 0.02,
      originationFee: 500,
      referralRate: 0.1,
      referralCap: 15_000,
      openerRate: 0.2,
      closerRate: 0.2,
      overrideRate: 0.05,
    });
    expect(r.basisAmount).toBe(100_000);
    expect(r.commission).toBe(10_000);
    expect(r.psf).toBe(2_000);
    expect(r.gross).toBe(12_500);
    expect(r.referralFee).toBe(1_250);
    expect(r.referralCapped).toBe(false);
    expect(r.net).toBe(11_250);
    expect(r.openerPayout).toBe(2_500); // on gross, not net
    expect(r.closerPayout).toBe(2_500);
    expect(r.overridePayout).toBe(625);
    expect(r.totalRepPayout).toBe(5_625);
    expect(r.houseNet).toBe(5_625); // 12,500 − 1,250 referral − 5,625 rep pay
    expect(r.net - r.totalRepPayout).toBe(r.houseNet);
  });

  it('uses payback as the basis for payback products', () => {
    const r = commissionFor({ amount: 100_000, basis: 'payback', factor: 1.4, commissionRate: 0.06 });
    expect(r.payback).toBe(140_000);
    expect(r.basisAmount).toBe(140_000);
    expect(r.commission).toBe(8_400);
  });

  it('uses the draw amount as the basis for draws', () => {
    const r = commissionFor({ amount: 25_000, basis: 'draw', commissionRate: 0.04 });
    expect(r.gross).toBe(1_000);
    expect(r.net).toBe(1_000);
  });

  it('caps the referral fee and reports it', () => {
    const r = commissionFor({ amount: 2_000_000, basis: 'funded', commissionRate: 0.1, referralRate: 0.15, referralCap: 15_000 });
    expect(r.referralFeeRaw).toBe(30_000);
    expect(r.referralFee).toBe(15_000);
    expect(r.referralCapped).toBe(true);
    expect(r.net).toBe(185_000);
  });

  it('accepts a zero rate everywhere and never goes negative', () => {
    const r = commissionFor({ amount: 10_000, basis: 'funded', commissionRate: 0 });
    expect(r.gross).toBe(0);
    expect(r.net).toBe(0);
    expect(r.houseNet).toBe(0);
  });
});

describe('paymentFor', () => {
  it('spreads payback over the payments the term holds at each frequency', () => {
    expect(paymentFor({ payback: 130_000, termDays: 100, frequency: 'Daily' })).toBe(1_300);
    expect(paymentFor({ payback: 130_000, termDays: 100, frequency: 'Weekly' })).toBe(6_500);
    expect(paymentFor({ payback: 130_000, termDays: 100, frequency: 'Bi-Weekly' })).toBe(13_000);
    expect(paymentFor({ payback: 130_000, termDays: 126, frequency: 'Monthly' })).toBe(21_666.67);
  });
  it('is null without payback or term', () => {
    expect(paymentFor({ payback: null, termDays: 100, frequency: 'Daily' })).toBeNull();
    expect(paymentFor({ payback: 1000, termDays: 0, frequency: 'Daily' })).toBeNull();
  });
});

describe('LOC line fee (Revenued)', () => {
  it('adds lineRate × line to gross at open; reps are paid on the whole', () => {
    const r = commissionFor({ amount: 50_000, basis: 'funded', commissionRate: 0.05, lineAmount: 90_000, lineRate: 0.05, openerRate: 0.4 });
    expect(r.commission).toBe(2_500);
    expect(r.lineFee).toBe(4_500);
    expect(r.gross).toBe(7_000);
    expect(r.openerPayout).toBe(2_800);
  });
  it('is zero without a line or a rate', () => {
    expect(commissionFor({ amount: 50_000, basis: 'funded', commissionRate: 0.05, lineAmount: 90_000 }).lineFee).toBe(0);
    expect(commissionFor({ amount: 50_000, basis: 'funded', commissionRate: 0.05, lineRate: 0.05 }).lineFee).toBe(0);
  });
});
