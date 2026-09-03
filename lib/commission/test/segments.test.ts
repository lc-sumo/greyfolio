import { describe, expect, it } from 'vitest';
import { segments, totalFunded, totalGross, totalNet } from '../src/segments.js';
import { makeDeal, makeDraw } from './fixtures.js';

describe('segments', () => {
  it('a single-funding product is one base segment', () => {
    const d = makeDeal({ id: 'F1', funded: 80_000, commRate: 0.1 });
    const segs = segments(d);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ sk: 'base', label: 'Initial', n: 0, amount: 80_000, gross: 8_000, net: 8_000 });
  });

  it('ten pulls on one LOC are ONE opportunity with ten draw lines, same deal id', () => {
    const draws = Array.from({ length: 10 }, (_, i) => makeDraw(i + 1, 10_000, 0.04));
    const d = makeDeal({ id: 'F12', product: 'LOC - INITIAL', funded: 40_000, commRate: 0.08, drawSubsequentPct: 0.04, draws });
    const segs = segments(d);
    expect(segs).toHaveLength(11);
    expect(segs.map((s) => s.sk)).toEqual(['base', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10']);
    expect(segs.every((s) => s.dealId === 'F12')).toBe(true);
    expect(segs[1]).toMatchObject({ label: 'Draw 1', amount: 10_000, commRate: 0.04, gross: 400 });
  });

  it('orders draws by n regardless of input order', () => {
    const d = makeDeal({ id: 'F2', draws: [makeDraw(2, 5_000, 0.04), makeDraw(1, 7_000, 0.04)] });
    expect(segments(d).map((s) => s.sk)).toEqual(['base', 'D1', 'D2']);
  });

  it('totals span every segment', () => {
    const d = makeDeal({ id: 'F3', funded: 40_000, commRate: 0.08, draws: [makeDraw(1, 25_000, 0.04), makeDraw(2, 18_000, 0.04)] });
    expect(totalFunded(d)).toBe(83_000);
    expect(totalGross(d)).toBe(3_200 + 1_000 + 720);
    expect(totalNet(d)).toBe(4_920);
  });
});
