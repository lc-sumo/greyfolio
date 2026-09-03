import { describe, expect, it } from 'vitest';
import { assertRepSafe, leaderboard, repClawbackViews, repDashboard, repDealView, repPayHistory, repRenewals, repStatements, repWallet } from '../src/scope.js';
import { clawbacks, deals, lines, reps, runs } from './memory-repo.js';

const ctx = { deals, lines, clawbacks };
const JULIAN = 'rep-julian-ribak';

describe('rep projections never leak', () => {
  it('assertRepSafe catches every forbidden key, nested or in arrays', () => {
    expect(() => assertRepSafe({ ok: 1, nested: [{ houseNet: 5 }] })).toThrow(/houseNet.*\$\.nested\[0\]/);
    expect(() => assertRepSafe({ a: { b: { referralFee: 1 } } })).toThrow(/referralFee/);
    expect(() => assertRepSafe({ share: 1, roles: ['Opener'] })).not.toThrow();
  });
  it('deal views carry no house net, referral, split ids/rates, or other reps', () => {
    for (const d of deals) {
      const v = repDealView(d, JULIAN, lines, clawbacks);
      assertRepSafe(v);
      const json = JSON.stringify(v);
      for (const r of reps) if (r.id !== JULIAN) expect(json).not.toContain(r.name);
    }
  });
  it('wallet, clawbacks, leaderboard and statements are rep-safe', () => {
    assertRepSafe(repWallet(ctx, JULIAN));
    assertRepSafe(repClawbackViews(ctx, JULIAN));
    assertRepSafe(leaderboard(ctx, reps, JULIAN));
    assertRepSafe(repStatements(ctx, runs, JULIAN));
  });
});

describe('repDealView', () => {
  it('shows the rep only their own role, rate, share and payment state', () => {
    const v = repDealView(deals[0]!, JULIAN, lines, clawbacks);
    expect(v).toMatchObject({ id: 'F1', funded: 10_000, roles: ['Opener'], share: 350, paid: 350, owed: 0, payoutStatus: 'Paid', commissionStatus: 'YES - Paid In Full', lenderPaidLabel: 'Collected' });
    expect(v.lines).toEqual([{ role: 'Opener', rate: 0.35, amount: 350, segment: 'Initial', segmentKey: 'base', paid: true, paidAmount: 350, units: null }]);
    expect(v.clawback).toEqual({ amount: 350, remaining: 250, status: 'open' });
  });
  it('a referral fee on the deal reduces the share but is never shown', () => {
    const v = repDealView(deals[1]!, JULIAN, lines, clawbacks);
    expect(v.share).toBe(700); // 2,000 gross × 35% — the referral fee is the house's, not the rep's
    // MBC has not paid F2 yet, so nothing is owed to Julian on it until the lender pays.
    expect(v).toMatchObject({ payoutStatus: 'Awaiting lender', accrued: 0, paid: 0, owed: 0, commissionStatus: 'Waiting for payment', lenderPaidLabel: 'Not collected' });
    expect(repDealView({ ...deals[1]!, commCollected: 2_000 }, JULIAN, lines, clawbacks)).toMatchObject({ payoutStatus: 'Owed', accrued: 700, owed: 700 });
    expect(JSON.stringify(v)).not.toContain('HUB TRACKER'); // referral partner name
  });
  it('the override rep sees their own override line', () => {
    const v = repDealView(deals[0]!, 'rep-raymond-amato', lines, clawbacks);
    expect(v.roles).toEqual(['Override']);
    expect(v.share).toBe(50);
  });
});

describe('repWallet', () => {
  it('reads repLedger and adds the awaiting-lender figure', () => {
    // Julian: earned 350 + 700 = 1,050; accrued 350 (F2 uncollected); paid 350 (gross); cash 250; held 250 (350 − 100 recovered); owed max(0, 350 − 350 − 250) = 0; 700 awaits MBC.
    expect(repWallet(ctx, JULIAN)).toEqual({ earned: 1_050, paid: 350, cash: 250, held: 250, recovered: 100, owed: 0, dealCount: 2, awaitingLender: 700 });
    // once MBC pays F2 the 700 accrues and, net of the 250 still held, 450 is owed
    const collected = { ...ctx, deals: ctx.deals.map((d) => (d.id === 'F2' ? { ...d, commCollected: 2_000 } : d)) };
    expect(repWallet(collected, JULIAN)).toMatchObject({ earned: 1_050, owed: 450, awaitingLender: 0 });
  });
});

describe('repClawbackViews', () => {
  it('shows remaining on open rows and what was withheld', () => {
    expect(repClawbackViews(ctx, JULIAN)).toEqual([
      { id: 'cb-1', dealId: 'F1', date: '2026-08-15', business: 'F1 Business', dealClawback: 1_000, chargedToMe: 350, recovered: 100, remaining: 250, reason: 'Merchant defaulted inside 30 days', status: 'open' },
    ]);
    expect(repClawbackViews(ctx, 'rep-noah-levine')).toEqual([]);
  });
});

describe('leaderboard', () => {
  it('anonymizes everyone but the viewer and appends the viewer if outside the top N', () => {
    const rows = leaderboard(ctx, reps, JULIAN, 2);
    expect(rows.map((r) => r.label)).toEqual(['Rep #1', 'You']); // Zach 400+800+500=1,700 > Julian 1,050
    expect(rows.find((r) => r.isMe)).toMatchObject({ rank: 2, commission: 1_050 });
    const small = leaderboard(ctx, reps, 'rep-noah-levine', 1);
    expect(small.map((r) => r.label)).toEqual(['Rep #1', 'You']);
    expect(small[1]).toMatchObject({ commission: 0 });
  });
});

describe('repStatements', () => {
  it('lists only periods where the rep had lines, with gross − clawbacks = net', () => {
    expect(repStatements(ctx, runs, JULIAN)).toEqual([{ runId: 'run-3', period: 'Aug 16 – Aug 31, 2026', status: 'paid', dealCount: 1, grossPaid: 350, clawbacks: 100, netPaid: 250 }]);
    expect(repStatements(ctx, runs, 'rep-zach-sanders')).toEqual([]);
  });
});

describe('repDashboard', () => {
  it('buckets earned by funded date and paid by cleared date, ranks within the period, and lists what is owed', () => {
    const d = repDashboard(ctx, reps, runs, JULIAN, '2026-07-01', '2026-09-02');
    assertRepSafe(d);
    expect(d.period).toMatchObject({ earned: 700, paid: 350, recovered: 100, owed: 0, funded: 20_000, dealCount: 1, rank: 2, repCount: 4 });
    expect(d.nextPayout).toEqual({ date: '2026-09-15', runLabel: 'Sep 1 – Sep 15, 2026', cycle: 'Twice monthly' });
    expect(d.monthly.map((m) => m.month)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(d.monthly.find((m) => m.month === '2026-06')).toEqual({ month: '2026-06', earned: 350, paid: 0 });
    expect(d.monthly.find((m) => m.month === '2026-08')).toEqual({ month: '2026-08', earned: 0, paid: 350 });
    expect(d.owedToMe).toEqual([]); // F2 is not collected yet — it waits with the lender, not in "owed to me"
    expect(d.wallet.owed).toBe(0);
    const collected = { ...ctx, deals: ctx.deals.map((x) => (x.id === 'F2' ? { ...x, commCollected: 2_000 } : x)) };
    expect(repDashboard(collected, reps, runs, JULIAN, '2026-07-01', '2026-09-02').owedToMe.map((v) => v.id)).toEqual(['F2']);
  });
  it('YTD includes June', () => {
    expect(repDashboard(ctx, reps, runs, JULIAN, '2026-01-01', '2026-09-02').period.earned).toBe(1_050);
  });
});

describe('repRenewals', () => {
  it('lists only the rep\'s deals with merchant contact, bucket, and their own est. share — no other rep names', () => {
    const rows = repRenewals(ctx, JULIAN, { renewalMark: 0.4 }, '2026-09-02');
    assertRepSafe(rows);
    expect(rows.map((r) => r.id).sort()).toEqual(['F1', 'F2']);
    const f1 = rows.find((r) => r.id === 'F1')!;
    expect(f1).toMatchObject({ merchantContact: 'Daniel Reyes', roles: ['Opener'], whoCalls: 'Closer', estRenewalShare: 350, funded: 10_000 });
    expect(f1.bucket).toBe('due'); // funded Jun 5, 120-day term → 40% mark ≈ Jul 31
    for (const r of rows) for (const rep of reps) if (rep.id !== JULIAN) expect(JSON.stringify(r)).not.toContain(rep.name);
    expect(repRenewals(ctx, 'rep-zach-sanders', { renewalMark: 0.4 }, '2026-09-02').find((r) => r.id === 'F3')?.whoCalls).toBe('You');
  });
});

describe('repPayHistory', () => {
  it('is every ledger row, newest first, grouped by day with gross − recovered = cash', () => {
    const h = repPayHistory(ctx, runs, JULIAN);
    assertRepSafe(h);
    expect(h.rows.map((r) => [r.dealId, r.role, r.segmentLabel, r.amount])).toEqual([['F1', 'Opener', 'Initial', 350], ['F1', 'Clawback recovery', 'Clawback', -100]]);
    expect(h.days).toHaveLength(1);
    expect(h.days[0]).toMatchObject({ date: '2026-08-31', runLabel: 'Aug 16 – Aug 31, 2026', grossPaid: 350, recovered: 100, cash: 250 });
    expect(h.summary).toEqual({ grossPaid: 350, recovered: 100, cash: 250, payouts: 1 });
    expect(repPayHistory(ctx, runs, 'rep-zach-sanders')).toMatchObject({ rows: [], days: [], summary: { grossPaid: 0, recovered: 0, cash: 0, payouts: 0 } });
  });
});
