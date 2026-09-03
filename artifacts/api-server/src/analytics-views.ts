/** Admin analytics: merchants and the funding overview. Read-only, admin-only. */
import {
  clawbackRepTotal,
  clawbackRecovered,
  collectedGross,
  crmUrl,
  dealCommissionStatus,
  effectiveDealStatus,
  outstandingGross,
  paidFigures,
  renewalOf,
  repLedger,
  sum,
  totalFunded,
  totalGross,
  totalNet,
  totalRepPayout,
  type Deal,
  type LedgerContext,
  type Rep,
} from '@greystone/commission';
import type { Settings } from './repo.js';

/* ---------- merchants ---------- */

export interface MerchantDealRow {
  id: string;
  crmId: string | null;
  date: string;
  business: string;
  lender: string;
  product: string;
  funded: number;
  gross: number;
  outstanding: number;
  commissionStatus: string;
  dealStatus: string;
  drawCount: number;
  crmUrl: string;
}

export interface MerchantRow {
  /** The identity key. Deals with no email group under their business name. */
  email: string;
  business: string;
  contact: string;
  phone: string;
  dealCount: number;
  funded: number;
  gross: number;
  outstanding: number;
  firstFunded: string;
  lastFunded: string;
  deals: MerchantDealRow[];
}

export function adminMerchants(ctx: LedgerContext, settings: Settings, today: string): MerchantRow[] {
  const groups = new Map<string, Deal[]>();
  for (const d of ctx.deals) {
    const key = (d.merchantEmail || `business:${d.business}`).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.entries()]
    .map(([key, deals]) => {
      const sorted = [...deals].sort((a, b) => b.date.localeCompare(a.date));
      const latest = sorted[0]!;
      return {
        email: key.startsWith('business:') ? '' : latest.merchantEmail,
        business: latest.business,
        contact: sorted.find((d) => d.merchantContact)?.merchantContact ?? '',
        phone: sorted.find((d) => d.merchantPhone)?.merchantPhone ?? '',
        dealCount: deals.length,
        funded: sum(deals.map(totalFunded)),
        gross: sum(deals.map(totalGross)),
        outstanding: sum(deals.map(outstandingGross)),
        firstFunded: sorted.at(-1)!.date,
        lastFunded: latest.date,
        deals: sorted.map((d) => ({
          id: d.id,
          crmId: d.crmId,
          date: d.date,
          business: d.business,
          lender: d.lender,
          product: d.product,
          funded: totalFunded(d),
          gross: totalGross(d),
          outstanding: outstandingGross(d),
          commissionStatus: dealCommissionStatus(d),
          dealStatus: effectiveDealStatus(d, settings.thresholds, today),
          drawCount: d.draws.length,
          crmUrl: crmUrl(settings.crm.urlTemplate, d),
        })),
      };
    })
    .sort((a, b) => b.funded - a.funded);
}

/* ---------- funding overview ---------- */

export interface Overview {
  period: { from: string; to: string };
  cards: {
    funded: number;
    commissions: number;
    opportunities: number;
    drawLines: number;
    avgDealSize: number;
    avgFactor: number | null;
    paid: number;
    owed: number;
    clawbackExposure: number;
    renewalReady: number;
    renewalGross: number;
  };
  monthly: Array<{ month: string; funded: number; commission: number }>;
  lenders: Array<{ lender: string; deals: number; funded: number; avgFactor: number | null; collectedPct: number }>;
  renewals: Array<{ id: string; crmId: string | null; business: string; lender: string; funded: number; markDate: string | null; whoCalls: string; estRenewalGross: number }>;
  clawbacks: Array<{ id: string; dealId: string; business: string; amount: number; repTotal: number; recovered: number; remaining: number; date: string }>;
}

export function adminOverview(ctx: LedgerContext, reps: Rep[], settings: Settings, from: string, to: string, today: string): Overview {
  const inPeriod = ctx.deals.filter((d) => d.date >= from && d.date <= to);
  const funded = sum(inPeriod.map(totalFunded));
  const factors = inPeriod.map((d) => d.factor).filter((f): f is number => typeof f === 'number' && f > 0);
  const paidRows = ctx.lines.filter((l) => l.paidAt >= from && l.paidAt <= to);
  const owed = sum(reps.map((r) => repLedger(ctx, r.id).owed));
  const openCbs = ctx.clawbacks.filter((c) => c.status === 'open');
  const byId = new Map(ctx.deals.map((d) => [d.id, d]));
  const exposure = openCbs.map((c) => {
    const d = byId.get(c.dealId);
    const repTotal = d ? clawbackRepTotal(c, d) : 0;
    const recovered = clawbackRecovered(ctx.lines, c.id);
    return { id: c.id, dealId: c.dealId, business: d?.business ?? c.dealId, amount: c.amount, repTotal, recovered, remaining: Math.max(0, repTotal - recovered), date: c.date };
  });
  const ren = ctx.deals.map((d) => ({ d, r: renewalOf(d, settings.thresholds, today) })).filter((x) => x.r.bucket === 'due');
  const first = (id: string | null) => (id ? (reps.find((r) => r.id === id)?.name ?? id).split(' ')[0]! : '—');

  const months: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= to.slice(0, 7); d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));

  const lenderMap = new Map<string, Deal[]>();
  for (const d of inPeriod) lenderMap.set(d.lender, [...(lenderMap.get(d.lender) ?? []), d]);

  return {
    period: { from, to },
    cards: {
      funded,
      commissions: sum(inPeriod.map(totalGross)),
      opportunities: inPeriod.length,
      drawLines: inPeriod.reduce((s, d) => s + d.draws.length, 0),
      avgDealSize: inPeriod.length ? sum([funded / inPeriod.length]) : 0,
      avgFactor: factors.length ? Math.round((factors.reduce((s, f) => s + f, 0) / factors.length) * 100) / 100 : null,
      paid: paidFigures(paidRows).gross,
      owed,
      clawbackExposure: sum(exposure.map((e) => e.remaining)),
      renewalReady: ren.length,
      renewalGross: sum(ren.map((x) => x.r.estRenewalGross)),
    },
    monthly: months.map((m) => {
      const ds = inPeriod.filter((d) => d.date.startsWith(m));
      return { month: m, funded: sum(ds.map(totalFunded)), commission: sum(ds.map(totalGross)) };
    }),
    lenders: [...lenderMap.entries()]
      .map(([lender, ds]) => {
        const fs = ds.map((d) => d.factor).filter((f): f is number => typeof f === 'number' && f > 0);
        const gross = sum(ds.map(totalGross));
        return { lender, deals: ds.length, funded: sum(ds.map(totalFunded)), avgFactor: fs.length ? Math.round((fs.reduce((s, f) => s + f, 0) / fs.length) * 100) / 100 : null, collectedPct: gross ? Math.round((sum(ds.map(collectedGross)) / gross) * 100) : 0 };
      })
      .sort((a, b) => b.funded - a.funded),
    renewals: ren
      .sort((a, b) => b.r.estRenewalGross - a.r.estRenewalGross)
      .slice(0, 6)
      .map(({ d, r }) => ({ id: d.id, crmId: d.crmId, business: d.business, lender: d.lender, funded: totalFunded(d), markDate: r.markDate, whoCalls: d.closerId ? first(d.closerId) : first(d.openerId), estRenewalGross: r.estRenewalGross })),
    clawbacks: exposure.sort((a, b) => b.remaining - a.remaining),
  };
}

/** Not used yet but kept for the sheet mirror: house net across a set of deals. */
export function houseNetOf(deals: Deal[]): number {
  return sum(deals.map((d) => totalNet(d) - totalRepPayout(d)));
}
