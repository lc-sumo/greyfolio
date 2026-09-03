import { sql } from 'drizzle-orm';
import { createDb } from '../index.js';
import { commissionClawbacks, commissionDealDraws, commissionDeals, commissionPayoutLines, commissionPayrollRuns, commissionReps, commissionTeams } from '../schema/commission.js';
import { buildDemo, demoSummary } from './demo.js';
import { seed } from './run.js';

/** Wipes deal, draw, ledger, clawback, run and team data, then loads the demo board. Reps/settings are (re)seeded first. */
export async function seedDemo(db: ReturnType<typeof createDb>, today?: string) {
  await seed(db);
  const demo = buildDemo(today);
  await db.transaction(async (tx) => {
    await tx.delete(commissionPayoutLines);
    await tx.delete(commissionClawbacks);
    await tx.delete(commissionDealDraws);
    await tx.delete(commissionDeals);
    await tx.delete(commissionPayrollRuns);
    await tx.update(commissionReps).set({ teamId: null });
    await tx.delete(commissionTeams);

    for (const t of demo.teams) await tx.insert(commissionTeams).values({ id: t.id, name: t.name, overrideRate: t.overrideRate });
    for (const r of demo.reps) await tx.update(commissionReps).set({ teamId: r.teamId, role: r.role, active: r.active, updatedAt: sql`now()` }).where(sql`${commissionReps.id} = ${r.id}`);
    for (const t of demo.teams) await tx.update(commissionTeams).set({ leaderRepId: t.leaderRepId }).where(sql`${commissionTeams.id} = ${t.id}`);
    for (const run of demo.runs) await tx.insert(commissionPayrollRuns).values({ id: run.id, label: run.label, start: run.start, end: run.end, status: run.status });
    for (const d of demo.deals) {
      const { draws, ...deal } = d;
      await tx.insert(commissionDeals).values(deal);
      for (const x of draws) await tx.insert(commissionDealDraws).values({ dealId: d.id, n: x.n, ref: x.ref, date: x.date, amount: x.amount, commRate: x.commRate, gross: x.gross, referralFee: x.referralFee, net: x.net, collected: x.collected, schedule: x.schedule });
    }
    for (const c of demo.clawbacks) await tx.insert(commissionClawbacks).values(c);
    if (demo.lines.length) await tx.insert(commissionPayoutLines).values(demo.lines);
  });
  return demoSummary(demo);
}

const isMain = process.argv[1] && /run-demo\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const db = createDb();
  seedDemo(db, process.env.DEMO_TODAY)
    .then((s) => {
      console.log('Demo board loaded:', s);
      return db.$client.end();
    })
    .catch(async (err) => {
      console.error(err);
      await db.$client.end();
      process.exit(1);
    });
}
