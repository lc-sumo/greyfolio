import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/commission.js';

export * from './schema/commission.js';
export * from './mappers.js';

export type Database = ReturnType<typeof createDb>;

/** Create a Drizzle client. Callers own the connection lifecycle (`client.end()`). */
export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  return Object.assign(db, { $client: client });
}
