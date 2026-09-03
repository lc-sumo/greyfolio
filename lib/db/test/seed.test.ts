import { describe, expect, it } from 'vitest';
import { commissionFor, defaultSplits, repOptions } from '@greystone/commission';
import { FUNDED_DEALS_COLUMNS, collectedFromSheetStatus, columnFor, parsePsfCell } from '../src/seed/funded-deals-columns.js';
import { COMMISSION_STATUSES, DEAL_STATUSES, FREQUENCIES, LENDERS, PARTNERS, PRODUCTS, THRESHOLDS, WORKBOOK_REPS, repEmail, repId, seedReps, seedSettings } from '../src/seed/workbook.js';

describe('REPS tab', () => {
  it('carries every rep on the workbook tab with rates as fractions', () => {
    expect(WORKBOOK_REPS).toHaveLength(19);
    for (const r of WORKBOOK_REPS) {
      expect(r.openerRate).toBeGreaterThan(0);
      expect(r.openerRate).toBeLessThanOrEqual(1);
      expect(r.closerRate).toBeGreaterThan(0);
      expect(r.closerRate).toBeLessThanOrEqual(1);
      if (r.overrideRate !== null) expect(r.overrideRate).toBeLessThanOrEqual(0.1);
    }
  });
  it('matches spot values from the sheet', () => {
    const by = Object.fromEntries(WORKBOOK_REPS.map((r) => [r.name, r]));
    expect(by['Azi Sharbani']).toMatchObject({ openerRate: 0.2, closerRate: 0.2, overrideRate: 0.05 });
    expect(by['Noah Levine']).toMatchObject({ openerRate: 0.2, closerRate: 0.15, overrideRate: null });
    expect(by['Solomon Gold']).toMatchObject({ openerRate: 0.2, closerRate: 0.15, overrideRate: null });
    expect(by['Jordan Levy']).toMatchObject({ openerRate: 0.2, closerRate: 0.2 });
    expect(by['Zach Sanders']).toBeUndefined(); // not on the tracker → not in the portal
  });
  it('produces unique ids and emails', () => {
    const reps = seedReps();
    expect(new Set(reps.map((r) => r.id)).size).toBe(reps.length);
    expect(new Set(reps.map((r) => r.email)).size).toBe(reps.length);
    expect(repId('Raymond Amato')).toBe('rep-raymond-amato');
    expect(repEmail('Raymond Amato')).toBe('raymond.amato@greystoneus.com');
  });
  it('only Leor is an admin; everyone is active and assignable', () => {
    const reps = seedReps();
    expect(reps.filter((r) => r.role === 'admin').map((r) => r.name)).toEqual(['Leor']);
    expect(repOptions(reps, 'assign')).toHaveLength(19);
  });
  it('defaults a new deal from the profiles', () => {
    const reps = seedReps();
    const opener = reps.find((r) => r.name === 'Azi Sharbani')!;
    const closer = reps.find((r) => r.name === 'Noah Levine')!;
    expect(defaultSplits(opener, closer, reps, [])).toEqual({ openerRate: 0.2, closerRate: 0.15, overrideId: null, overrideRate: 0 });
  });
});

describe('SETTINGS tab', () => {
  it('lists the workbook lenders, products, statuses and frequencies', () => {
    expect(LENDERS.map((l) => l.name)).toEqual(['MBC', 'GFE', 'House', 'Forward', 'Lendini', 'Wall', 'LG', 'Capitalize', 'Byzfunder', 'RTMI', 'Highland Hill', 'Revenued']);
    expect(PRODUCTS.map((p) => p.name)).toEqual([
      'MCA',
      'LOC - INITIAL',
      'LOC DRAW',
      'CONSOLIDATION - UPFRONT COMM',
      'CONSOLIDATION DISBURSEMENT',
      'REVERSE - TOTAL FUNDING',
      'REVERSE - DISBURSEMENT',
      'TERM LOAN',
      'EQUIPMENT',
      'REAL ESTATE',
      'SBA',
    ]);
    expect(COMMISSION_STATUSES).toEqual(['Waiting for payment', 'Invoice Sent', 'Partially Paid', 'YES - Paid In Full', 'Clawed Back', 'NO - Never got paid']);
    expect(DEAL_STATUSES).toEqual(['Performing', 'Prospecting', 'Refi Ready', 'Refinanced', 'Default', 'Paid In Full']);
    expect(FREQUENCIES).toEqual(['Daily', 'Weekly', 'Bi-Weekly', 'Monthly']);
  });
  it('thresholds match SETTINGS!I', () => {
    expect(THRESHOLDS).toEqual({ clawbackWindowDays: 30, paymentOverdueDays: 14, renewalMark: 0.4, additionalCapitalAfterDays: 30 });
  });
  it('weekly lenders carry a week count; upfront lenders carry none', () => {
    for (const l of LENDERS) {
      if (l.terms === 'weekly') expect(l.weeks).toBeGreaterThan(0);
      else expect(l.weeks).toBe(0);
    }
  });
  it('product rules are internally consistent', () => {
    for (const p of PRODUCTS) {
      expect(['funded', 'draw', 'payback']).toContain(p.basis);
      expect(p.comm).toBeGreaterThan(0);
      expect(p.comm).toBeLessThan(1);
      if (p.multiDraw) {
        expect(p.drawInitial).not.toBeNull();
        expect(p.drawSubsequent).not.toBeNull();
      } else {
        expect(p.drawInitial).toBeNull();
        expect(p.drawSubsequent).toBeNull();
      }
      if (p.basis === 'draw') expect(p.parent).toBe(true);
    }
  });
  it('every product rule can price a deal', () => {
    for (const p of PRODUCTS) {
      const r = commissionFor({ amount: 100_000, basis: p.basis, factor: p.factor ? 1.3 : null, termDays: p.term ? 120 : null, commissionRate: p.comm });
      expect(r.gross).toBeGreaterThan(0);
      expect(r.net).toBe(r.gross);
    }
  });
});

describe('PARTNERS tab', () => {
  it('is verbatim, including the uncapped partners', () => {
    expect(PARTNERS).toEqual([
      { name: 'MBC', pct: 0.15, monthlyCap: 15_000 },
      { name: 'NONE', pct: 0.1, monthlyCap: null },
      { name: 'HUB TRACKER', pct: 0.1, monthlyCap: null },
      { name: 'None', pct: 0, monthlyCap: null },
    ]);
  });
  it('MBC caps at $15,000 a month', () => {
    const r = commissionFor({ amount: 1_000_000, basis: 'funded', commissionRate: 0.12, referralRate: 0.15, referralCap: 15_000 });
    expect(r.referralFee).toBe(15_000);
    expect(r.referralCapped).toBe(true);
  });
});

describe('seedSettings', () => {
  it('writes one row per settings key', () => {
    expect(seedSettings().map((s) => s.key)).toEqual(['lenders', 'partners', 'products', 'thresholds', 'lists', 'crm', 'payroll']);
  });
  it('ships a blank CRM template so no link renders until the real pattern is known', () => {
    expect(seedSettings().find((s) => s.key === 'crm')?.value).toEqual({ urlTemplate: '' });
  });
});

describe('FUNDED DEALS column map', () => {
  const HEADERS = [
    'Deal ID', 'Parent Deal', 'Date', 'Business Name', 'Lender', 'Product', 'Funded / Draw Amount ($)', 'Factor Rate', 'Term (bus. days)', 'Payback ($)',
    'Frequency', 'Comm %', 'PSF (% or $)', 'PSF $ (auto)', 'Gross Commission ($)', 'Referral Partner', 'Referral %', 'Referral Fee ($)', 'Net Comm After Referral ($)',
    'Opener', 'Opener %', 'Opener $', 'Closer', 'Closer %', 'Closer $', 'Override Rep', 'Override %', 'Override $', 'Total Rep Payout ($)', 'HOUSE NET ($)',
    'Clawback $', 'Clawback Date', 'Opener CB $', 'Closer CB $', 'Override CB $', 'Rep Clawback $', 'House Clawback $', 'House Net After Clawback ($)',
    'Commission Status', 'Lender Paid Date', 'Rep Paid Date', 'Est. Renewal (40% in)', 'Deal Status', 'Maturity Date', 'Notes', 'CB Risk', 'Lead Source',
  ];
  it('covers the 48-column master, A through AX, in order', () => {
    expect(FUNDED_DEALS_COLUMNS).toHaveLength(50);
    expect(FUNDED_DEALS_COLUMNS.slice(0, HEADERS.length).map((c) => c.header)).toEqual(HEADERS);
    const letters = FUNDED_DEALS_COLUMNS.map((c) => c.col);
    expect(letters.slice(0, 26)).toEqual('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
    expect(letters.slice(26)).toEqual(['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AV', 'AW', 'AX']);
  });
  it('maps the stored deal columns', () => {
    expect(columnFor('id')).toBe('A');
    expect(columnFor('date')).toBe('C');
    expect(columnFor('merchantEmail')).toBeUndefined(); // not in the workbook (open question #5)
    expect(columnFor('repPaid')).toBe('AO');
    expect(FUNDED_DEALS_COLUMNS.find((c) => c.col === 'AO')?.kind).toBe('derived');
    expect(FUNDED_DEALS_COLUMNS.find((c) => c.col === 'AM')?.kind).toBe('derived');
  });
  it('reads the PSF cell the way the sheet does', () => {
    expect(parsePsfCell(null)).toEqual({ psfRate: 0, psfDollars: 0 });
    expect(parsePsfCell(2)).toEqual({ psfRate: 0.02, psfDollars: 0 });
    expect(parsePsfCell(0.02)).toEqual({ psfRate: 0.02, psfDollars: 0 });
    expect(parsePsfCell(500)).toEqual({ psfRate: 0, psfDollars: 500 });
  });
  it('turns a sheet status into collected dollars only at import', () => {
    expect(collectedFromSheetStatus('YES - Paid In Full', 1000)).toBe(1000);
    expect(collectedFromSheetStatus('Partially Paid', 1000)).toBe(500);
    expect(collectedFromSheetStatus('Invoice Sent', 1000)).toBe(0);
    expect(collectedFromSheetStatus('Waiting for payment', 1000)).toBe(0);
    expect(collectedFromSheetStatus(null, 1000)).toBe(0);
  });
});
