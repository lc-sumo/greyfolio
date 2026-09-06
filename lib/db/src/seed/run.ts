/**
 * Seed the database from the workbook constants. Idempotent and never
 * destructive: a rep or settings row that already exists is left exactly as
 * it is, so leaving SEED=workbook on cannot undo edits made in Settings.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @greystone/db seed
 */
import { createDb } from '../index.js';
import { commissionReps, commissionSettings, commissionSheetsSync } from '../schema/commission.js';
import { seedReps, seedSettings } from './workbook.js';

export async function seed(db: ReturnType<typeof createDb>): Promise<{ reps: number; settings: number }> {
  const reps = seedReps();
  await db.transaction(async (tx) => {
    for (const r of reps) {
      await tx
        .insert(commissionReps)
        .values({
          id: r.id,
          name: r.name,
          email: r.email,
          role: r.role,
          openerRate: r.openerRate,
          closerRate: r.closerRate,
          overrideRate: r.overrideRate,
          active: r.active,
        })
        .onConflictDoNothing();
    }
    for (const s of seedSettings()) {
      await tx
        .insert(commissionSettings)
        .values({ key: s.key, value: s.value as never })
        .onConflictDoNothing();
    }
    await tx.insert(commissionSheetsSync).values({ id: 'default' }).onConflictDoNothing();
  });
  return { reps: reps.length, settings: seedSettings().length };
}

const isMain = process.argv[1] && /seed[\\/]run\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const db = createDb();
  seed(db)
    .then((r) => {
      console.log(`Seeded ${r.reps} reps and ${r.settings} settings rows`);
      return db.$client.end();
    })
    .catch(async (err) => {
      console.error(err);
      await db.$client.end();
      process.exit(1);
    });
}
