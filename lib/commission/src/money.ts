/**
 * Money helpers. All monetary amounts in the domain are plain numbers in
 * dollars, rounded to cents at every boundary so that sums of lines equal
 * the totals they were derived from.
 */

/** Round to cents. Uses EPSILON so 1.005 → 1.01 rather than 1.00. */
export function cents(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Sum a list of numbers to cents. */
export function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return cents(total);
}

/** Clamp `n` into [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * A rate may arrive as a fraction (0.2) or a percent (20). The workbook
 * accepts both (`IF(U4>1,U4/100,U4)`); the portal normalises to a fraction.
 */
export function asRate(v: number | null | undefined): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 0;
  return v > 1 ? v / 100 : v;
}
