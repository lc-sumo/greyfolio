/**
 * Demo board: a realistic, DETERMINISTIC set of deals, draws, weekly
 * schedules, payroll runs, payout lines and clawbacks — so every portal
 * screen shows real numbers. Everything monetary goes through the domain
 * layer (`commissionFor`, `newDraw`, `planPayout`), so the ledger the demo
 * writes satisfies the same invariants production data must.
 *
 * Reps, lenders, products and partners come from the workbook seed. Teams,
 * merchants, deals and payments are generated.
 *
 *   DATABASE_URL=… pnpm --filter @greystone/db seed:demo    (wipes deal data first)
 */
import {
  applyPayout,
  commissionFor,
  defaultSplits,
  newDraw,
  payableLines,
  planPayout,
  scheduleFor,
  segments,
  totalRepPayout,
  type Clawback,
  type Deal,
  type LedgerContext,
  type PayoutLine,
  type PayrollRun,
  type Rep,
  type SegmentKey,
  type Team,
} from '@greystone/commission';
import { LENDERS, PARTNERS, PRODUCTS, seedReps } from './workbook.js';

export interface DemoData {
  today: string;
  teams: Team[];
  reps: Rep[];
  deals: Deal[];
  runs: PayrollRun[];
  clawbacks: Clawback[];
  lines: PayoutLine[];
}

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY));
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY);

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, pick, int };
}

const BIZ_A = ['Northstar', 'Harbor Street', 'Cedar & Stone', 'Ironwood', 'Blue Ridge', 'Sunset', 'Vertex', 'Copper Creek', 'Lakeshore', 'Granite Bay', 'Old Mill', 'Redline', 'Sterling', 'Fairview', 'Pacific', 'Halcyon', 'Brightwater', 'Kingsway', 'Ember', 'Foxglove', 'Quarry Road', 'Silverline', 'Trinity', 'Windrow', 'Mercer', 'Ashford', 'Bellwood', 'Crosstown', 'Dunmore', 'Eastgate'];
const BIZ_B = ['Dental Group', 'Fitness', 'Supply Co', 'Logistics', 'HVAC', 'Auto Care', 'Staffing', 'Restaurant Group', 'Construction', 'Medical Spa', 'Landscaping', 'Trucking', 'Roofing', 'Electric', 'Plumbing', 'Print Works', 'Grocery', 'Cleaning Services', 'Machine Shop', 'Pharmacy'];
const FIRST = ['Daniel', 'Maria', 'Jonathan', 'Priya', 'Andre', 'Rachel', 'Victor', 'Simone', 'Owen', 'Nadia', 'Trevor', 'Camille', 'Isaac', 'Leah', 'Marcus', 'Sofia', 'Colin', 'Yara', 'Devin', 'Bianca'];
const LAST = ['Reyes', 'Duran', 'Kaplan', 'Nair', 'Laurent', 'Stein', 'Ruiz', 'Blake', 'Pryce', 'Rahim', 'Cole', 'Ferrer', 'Frank', 'Mendez', 'Whitley', 'Vega', 'Barrett', 'Nasser', 'Moore', 'Hale'];
const REASONS = ['Merchant defaulted inside 30 days', 'Early payoff adjustment', 'Lender reversed PSF', 'Deal refinanced within clawback window'];
const SOURCES = ['Broker referral', 'Inbound', 'Existing client', 'Cold outreach', 'Renewal'];

/** Twice-monthly runs covering the demo window, oldest first. */
export function demoRuns(today: string, monthsBack = 4): PayrollRun[] {
  const runs: PayrollRun[] = [];
  const t = new Date(`${today}T00:00:00Z`);
  for (let m = monthsBack; m >= 0; m--) {
    const y = t.getUTCFullYear();
    const mo = t.getUTCMonth() - m;
    const first = new Date(Date.UTC(y, mo, 1));
    const mid = new Date(Date.UTC(y, mo, 15));
    const last = new Date(Date.UTC(y, mo + 1, 0));
    const label = (a: Date, b: Date) => `${a.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${b.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
    for (const [a, b] of [
      [first, mid],
      [new Date(Date.UTC(y, mo, 16)), last],
    ] as const) {
      if (iso(a) > today) continue;
      const n = runs.length + 1;
      const status: PayrollRun['status'] = iso(b) < addDays(today, -7) ? 'paid' : iso(b) < today ? 'approved' : 'draft';
      runs.push({ id: `run-${n}`, label: label(a, b), start: iso(a), end: iso(b), status });
    }
  }
  return runs;
}

export function buildDemo(today = iso(new Date()), seed = 20260902): DemoData {
  const r = rng(seed);
  const reps = seedReps().map((x) => ({ ...x }));
  const byName = (n: string) => reps.find((x) => x.name === n)!;

  // Teams are placeholders (open question #4). Leaders become managers for the demo.
  const teams: Team[] = [
    { id: 'team-amato', name: 'Team Amato', leaderRepId: byName('Raymond Amato').id, overrideRate: 0.05 },
    { id: 'team-sharbani', name: 'Team Sharbani', leaderRepId: byName('Azi Sharbani').id, overrideRate: 0.05 },
    { id: 'team-gold', name: 'Team Gold', leaderRepId: byName('Solomon Gold').id, overrideRate: 0.05 },
    { id: 'team-reed', name: 'Team Reed', leaderRepId: byName('Jason Reed').id, overrideRate: 0.05 },
  ];
  reps.forEach((rep, i) => {
    rep.teamId = teams[i % teams.length]!.id;
  });
  for (const t of teams) {
    const lead = reps.find((x) => x.id === t.leaderRepId)!;
    lead.teamId = t.id;
    if (lead.role === 'rep') lead.role = 'manager';
  }
  // One departed rep so invariant #9 is visible.
  byName('Levi Forgash').active = false;

  const lenderByName = new Map(LENDERS.map((l) => [l.name, l]));
  const partnerByName = new Map(PARTNERS.map((p) => [p.name, p]));
  const fundableProducts = PRODUCTS.filter((p) => !p.parent);
  const activeReps = reps.filter((x) => x.active);

  const deals: Deal[] = [];
  const clawbacks: Clawback[] = [];
  let n = 0;
  const start = addDays(today, -200);
  for (let cursor = start; cursor <= today; cursor = addDays(cursor, r.int(2, 5))) {
    n++;
    const id = `F${n}`;
    const lender = r.pick(LENDERS);
    // A lender funds only the products it is set up for (Settings › Lenders).
    const funds = fundableProducts.filter((p) => !lender.products?.length || lender.products.includes(p.name));
    const product = r.pick(funds.length ? funds : fundableProducts);
    const partnerName = r.pick(['None', 'None', 'None', 'MBC', 'HUB TRACKER']);
    const partner = partnerByName.get(partnerName)!;
    const funded = Math.round((28 + r.next() * 420) * 1000);
    const factor = product.factor ? 1.22 + r.int(0, 27) / 100 : null;
    const apr = product.factor ? null : r.int(9, 18);
    const termDays = product.term ? r.pick([90, 120, 150, 180, 210, 240, 270]) : null;
    const commRate = product.multiDraw ? product.drawInitial! : Math.max(0.02, product.comm + r.int(-2, 2) / 100);
    const psfPct = r.next() > 0.7 ? r.int(1, 3) / 100 : 0;
    const originationFee = r.next() > 0.8 ? r.int(2, 10) * 100 : 0;

    const opener = r.pick(activeReps);
    let closer = r.pick(activeReps);
    if (closer.id === opener.id) closer = activeReps[(activeReps.indexOf(closer) + 7) % activeReps.length]!;
    const splits = defaultSplits(opener, closer, reps, teams);

    const calc = commissionFor({ amount: funded, basis: product.basis, factor, apr, termDays, commissionRate: commRate, psfRate: psfPct, originationFee, referralRate: partner.pct, referralCap: partner.monthlyCap });
    const bIdx = n % BIZ_A.length;
    const business = `${BIZ_A[bIdx]} ${BIZ_B[(n * 3) % BIZ_B.length]}`;
    const fn = FIRST[bIdx % FIRST.length]!;
    const ln = LAST[(bIdx * 3) % LAST.length]!;
    const age = daysBetween(cursor, today);
    const schedule = product.incremental ? scheduleFor(lender, addDays(cursor, 7)) : null;
    if (schedule) schedule.received = Math.min(schedule.weeks, Math.floor(age / 7));
    // now and then a merchant opts out part-way: the plan stops at the increments taken
    if (schedule && schedule.received >= 4 && schedule.received < schedule.weeks && r.next() < 0.15) schedule.stoppedAfter = schedule.received;
    const collected = schedule ? null : age > 40 ? calc.gross : age > 18 ? (r.next() > 0.45 ? calc.gross : Math.round(calc.gross * 0.5)) : 0;
    const slow = age > 30 && r.next() > 0.9;

    const deal: Deal = {
      id,
      opportunityId: id,
      parentId: null,
      date: cursor,
      business,
      merchantContact: `${fn} ${ln}`,
      merchantEmail: `${(fn[0]! + ln).toLowerCase()}@${business.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.com`,
      merchantPhone: `(${201 + ((bIdx * 17) % 700)}) ${200 + ((bIdx * 29) % 799)}-${1000 + ((bIdx * 337) % 8999)}`,
      lender: lender.name,
      product: product.name,
      funded,
      factor,
      apr,
      termDays,
      frequency: r.pick(['Daily', 'Daily', 'Weekly']),
      payback: calc.payback,
      commRate,
      psfPct,
      originationFee,
      referralPartner: partner.pct > 0 ? partner.name : null,
      referralRate: partner.pct,
      gross: calc.gross,
      referralFee: calc.referralFee,
      net: calc.net,
      openerId: opener.id,
      openerRate: splits.openerRate,
      closerId: closer.id,
      closerRate: splits.closerRate,
      overrideId: splits.overrideId,
      overrideRate: splits.overrideRate,
      commCollected: collected,
      commSchedule: schedule,
      creditLine: product.multiDraw ? Math.round(funded * (2 + r.next() * 3)) : null,
      drawInitialPct: product.multiDraw ? product.drawInitial : null,
      drawSubsequentPct: product.multiDraw ? product.drawSubsequent : null,
      dealStatus: slow ? r.pick(['Slow Pay', 'Default']) : age > 150 ? r.pick(['Refinanced', 'Refi Ready', 'Performing']) : 'Performing',
      repPaid: null,
      lenderPaid: (schedule ? schedule.received > 0 : (collected ?? 0) > 0) ? addDays(cursor, 6) : null,
      crmId: `OPP-${String(48000 + n * 37 + r.int(0, 8)).padStart(5, '0')}`,
      draws: [],
    };

    if (product.multiDraw) {
      const pulls = r.int(1, 6);
      for (let k = 1; k <= pulls; k++) {
        const date = addDays(cursor, k * 18 + r.int(0, 12));
        if (date > today) break;
        const amount = Math.round(((0.1 + r.next() * 0.35) * deal.creditLine!) / 1000) * 1000;
        const dAge = daysBetween(date, today);
        const draw = newDraw(deal, { amount, date, partner: partner.pct > 0 ? partner : null, schedule: product.incremental ? scheduleFor(lender, addDays(date, 7)) : null });
        if (draw.schedule) draw.schedule.received = Math.min(draw.schedule.weeks, Math.floor(dAge / 7));
        else draw.collected = dAge > 35 ? draw.gross : dAge > 14 && r.next() > 0.5 ? Math.round(draw.gross / 2) : 0;
        deal.draws.push(draw);
      }
    }
    deals.push(deal);

    if (slow && r.next() > 0.35) {
      const net = segments(deal).reduce((s, x) => s + x.net, 0);
      clawbacks.push({
        id: `cb-${clawbacks.length + 1}`,
        dealId: id,
        date: addDays(cursor, Math.min(age, 40)),
        amount: Math.round(net * (0.3 + r.next() * 0.5)),
        recovered: 0,
        reason: r.pick(REASONS),
        status: 'open',
      });
    }
    void SOURCES;
  }

  // Payroll history: each paid run pays every line whose commission the lender had fully
  // collected by the run end, through planPayout so recoveries are real ledger rows.
  const runs = demoRuns(today);
  let ctx: LedgerContext = { deals, lines: [], clawbacks: [] };
  for (const run of runs) {
    if (run.status !== 'paid') continue;
    ctx = { ...ctx, clawbacks: clawbacks.filter((c) => c.date <= run.end).map((c) => ctx.clawbacks.find((x) => x.id === c.id) ?? c) };
    for (const rep of reps) {
      const keys = payableLines(ctx.deals, ctx.lines, rep.id)
        .filter((l) => l.segment.date <= run.end && fullyCollectedBy(l.segment, run.end, today))
        .map((l) => l.key);
      if (!keys.length) continue;
      const plan = planPayout(ctx, { repId: rep.id, selectedKeys: keys, runId: run.id, paidAt: run.end });
      ctx = applyPayout(ctx, plan);
    }
  }
  // Carry the run-updated clawbacks back over the originals.
  const finalClawbacks = clawbacks.map((c) => ctx.clawbacks.find((x) => x.id === c.id) ?? c);
  return { today, teams, reps, deals: ctx.deals, runs, clawbacks: finalClawbacks, lines: ctx.lines };
}

/** Was this segment's commission fully collected as of `asOf`? (Approximates the schedule backwards.) */
function fullyCollectedBy(seg: ReturnType<typeof segments>[number], asOf: string, today: string): boolean {
  const s = seg.schedule;
  if (s) {
    const weeksThen = Math.max(0, s.received - Math.floor(daysBetween(asOf, today) / 7));
    return weeksThen >= s.weeks;
  }
  return (seg.collected ?? 0) >= seg.gross && daysBetween(seg.date, asOf) > 40;
}

/** Sanity checks a demo must pass — mirrors what tests assert. */
export function demoSummary(d: DemoData) {
  const withDraws = d.deals.filter((x) => x.draws.length).length;
  const weekly = d.deals.filter((x) => x.commSchedule).length;
  return {
    deals: d.deals.length,
    withDraws,
    weekly,
    runs: d.runs.length,
    paidRuns: d.runs.filter((x) => x.status === 'paid').length,
    lines: d.lines.length,
    recoveries: d.lines.filter((x) => x.role === 'Clawback recovery').length,
    clawbacks: d.clawbacks.length,
    recovered: d.clawbacks.filter((x) => x.status === 'recovered').length,
    totalRepPayout: d.deals.reduce((s, x) => s + totalRepPayout(x), 0),
    segmentKeys: [...new Set(d.deals.flatMap((x) => segments(x).map((s) => s.sk as SegmentKey)))],
  };
}
