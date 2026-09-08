import { describe, expect, it } from 'vitest';
import { clawbackRecovered, clawbackRepTotal, clawbackSlices, clawbackStatus, clawbacksFor, hasLenderClawbackParticipation, repClawback } from '../src/clawback.js';
import { lenderClawbackBase } from '../src/segments.js';
import { line, makeClawback, makeDeal, makeDraw } from './fixtures.js';

describe('repClawback', () => {
  // F1: funded 10,000 @ 10% → net 1,000. Opener rep-07 @35% = 350, closer rep-05 @40% = 400, override rep-02 @5% = 50.
  const deal = makeDeal({ id: 'F1', funded: 10_000, commRate: 0.1 });

  it('a full clawback means the rep repays their full share', () => {
    const cb = makeClawback('cb-1', 'F1', 1_000);
    expect(repClawback(cb, deal, 'rep-07', [])).toEqual({ share: 350, recovered: 0, remaining: 350 });
    expect(repClawback(cb, deal, 'rep-05', [])).toEqual({ share: 400, recovered: 0, remaining: 400 });
    expect(repClawback(cb, deal, 'rep-02', [])).toEqual({ share: 50, recovered: 0, remaining: 50 });
  });

  it('a partial clawback is pro-rata: repShare × amount / totalNet', () => {
    const cb = makeClawback('cb-2', 'F1', 350);
    expect(repClawback(cb, deal, 'rep-07', []).share).toBe(122.5);
    expect(repClawback(cb, deal, 'rep-05', []).share).toBe(140);
  });

  it('recovered comes from negative ledger rows, and remaining nets against it — not the full share', () => {
    const cb = makeClawback('cb-3', 'F1', 1_000);
    const rows = [line('cbrec|cb-3|run-2|rep-07', 'rep-07', -200, { role: 'Clawback recovery', clawbackId: 'cb-3', segmentKey: null })];
    expect(repClawback(cb, deal, 'rep-07', rows)).toEqual({ share: 350, recovered: 200, remaining: 150 });
    expect(repClawback(cb, deal, 'rep-05', rows)).toEqual({ share: 400, recovered: 0, remaining: 400 });
  });

  it('a status flag alone recovers nothing — only rows count', () => {
    const cb = makeClawback('cb-4', 'F1', 1_000, { recovered: 350, status: 'recovered' });
    expect(repClawback(cb, deal, 'rep-07', []).recovered).toBe(0);
  });

  it('recovered never exceeds share', () => {
    const cb = makeClawback('cb-5', 'F1', 1_000);
    const rows = [line('cbrec|cb-5|run-2|rep-07', 'rep-07', -999, { role: 'Clawback recovery', clawbackId: 'cb-5', segmentKey: null })];
    expect(repClawback(cb, deal, 'rep-07', rows)).toEqual({ share: 350, recovered: 350, remaining: 0 });
  });

  it('is zero for a rep not on the deal, or a clawback on another deal', () => {
    const cb = makeClawback('cb-6', 'F1', 1_000);
    expect(repClawback(cb, deal, 'rep-99', [])).toEqual({ share: 0, recovered: 0, remaining: 0 });
    expect(repClawback(cb, makeDeal({ id: 'F2' }), 'rep-07', [])).toEqual({ share: 0, recovered: 0, remaining: 0 });
  });

  it('clawback amount is capped at the deal net', () => {
    const cb = makeClawback('cb-7', 'F1', 5_000);
    expect(repClawback(cb, deal, 'rep-07', []).share).toBe(350);
    expect(clawbackRepTotal(cb, deal)).toBe(800);
  });

  it('uses only lender-paid commission when a merchant PSF is present', () => {
    // The $1,000 gross contains $800 lender commission plus $200 merchant PSF.
    const psfDeal = makeDeal({
      id: 'F-PSF', funded: 10_000, commRate: 0.08, psfPct: 0.02,
      openerId: 'rep-07', openerRate: 0.35, closerId: null, overrideId: null,
    });
    const cb = makeClawback('cb-psf', psfDeal.id, 800);
    expect(psfDeal.gross).toBe(1_000);
    expect(lenderClawbackBase(psfDeal)).toBe(800);
    // The original gross payout would be $350, but the new debt is 35% of
    // lender dollars only ($280).
    expect(repClawback(cb, psfDeal, 'rep-07', []).share).toBe(280);
  });

  it('uses the effective stopped base plus LOC draws, never PSF', () => {
    const deal = makeDeal({
      id: 'F-STOP', funded: 10_000, commRate: 0.08, psfPct: 0.02,
      commSchedule: { mode: 'weekly', weeks: 2, received: 1, startDate: '2026-08-01', stoppedAfter: 1 },
      draws: [makeDraw(1, 1_000, 0.1)],
    });
    // The stopped base is half of $800 lender commission ($400); D1 adds its
    // full $100 lender commission. The unearned half of the $200 PSF is not
    // clawbackable either.
    expect(lenderClawbackBase(deal)).toBe(500);
  });

  it('does not attribute or list a clawback where no lender-paid component exists', () => {
    const psfOnly = makeDeal({ id: 'F-PSF-ONLY', commRate: 0, psfPct: 0.02, openerId: 'rep-07', openerRate: 0.35 });
    const cb = makeClawback('cb-psf-only', psfOnly.id, 1);
    expect(lenderClawbackBase(psfOnly)).toBe(0);
    expect(hasLenderClawbackParticipation(psfOnly, 'rep-07')).toBe(false);
    expect(repClawback(cb, psfOnly, 'rep-07', [])).toEqual({ share: 0, recovered: 0, remaining: 0 });
    expect(clawbacksFor([cb], [psfOnly], 'rep-07')).toEqual([]);
  });
});

describe('clawback roll-ups', () => {
  const deal = makeDeal({ id: 'F1', funded: 10_000, commRate: 0.1 });
  const cb = makeClawback('cb-1', 'F1', 1_000);

  it('slices cover every rep on the deal once', () => {
    expect(clawbackSlices(cb, deal, []).map((s) => [s.repId, s.share])).toEqual([['rep-07', 350], ['rep-05', 400], ['rep-02', 50]]);
  });
  it('status is derived: open until every slice is withheld', () => {
    const partial = [line('cbrec|cb-1|run-2|rep-07', 'rep-07', -350, { role: 'Clawback recovery', clawbackId: 'cb-1', segmentKey: null })];
    expect(clawbackStatus(cb, deal, partial)).toBe('open');
    expect(clawbackRecovered(partial, 'cb-1')).toBe(350);
    const all = [
      ...partial,
      line('cbrec|cb-1|run-2|rep-05', 'rep-05', -400, { role: 'Clawback recovery', clawbackId: 'cb-1', segmentKey: null }),
      line('cbrec|cb-1|run-2|rep-02', 'rep-02', -50, { role: 'Clawback recovery', clawbackId: 'cb-1', segmentKey: null }),
    ];
    expect(clawbackRecovered(all, 'cb-1')).toBe(800);
    expect(clawbackStatus(cb, deal, all)).toBe('recovered');
  });
});
