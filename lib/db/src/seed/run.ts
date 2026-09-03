/**
 * Seed the database from the workbook constants. Idempotent: reps upsert on
 * id (team assignment is preserved), settings upsert on key.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @greystone/db seed
 */
import { sql } from 'drizzle-orm';
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
        .onConflictDoUpdate({
          target: commissionReps.id,
          set: {
            name: r.name,
            openerRate: r.openerRate,
            closerRate: r.closerRate,
            overrideRate: r.overrideRate,
            active: r.active,
            updatedAt: sql`now()`,
          },
        });
    }
    for (const s of seedSettings()) {
      await tx
        .insert(commissionSettings)
        .values({ key: s.key, value: s.value as never })
        .onConflictDoUpdate({ target: commissionSettings.key, set: { value: s.value as never, updatedAt: sql`now()` } });
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
