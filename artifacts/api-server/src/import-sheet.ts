/** `pnpm --filter @greystone/api-server import:sheet path/to/funded-deals.csv [--commit]` — preview by default. */
import { readFileSync } from 'node:fs';
import { createDb } from '@greystone/db';
import { dbRepo } from './repo.db.js';
import { commitImport, previewImport } from './services/import.js';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('usage: import:sheet <funded-deals.csv> [--commit]');
  process.exit(2);
}
const csv = readFileSync(file, 'utf8');
const repo = dbRepo(createDb());
const preview = await previewImport(repo, csv);
console.log(JSON.stringify(preview.summary, null, 2));
for (const r of preview.rows.filter((x) => x.problems.length)) console.log(`line ${r.line} ${r.id || '(new)'} ${r.business}: ${r.problems.join('; ')}`);
if (flag === '--commit') {
  if (preview.summary.problems) { console.error('Fix the problems above first.'); process.exit(1); }
  console.log(JSON.stringify(await commitImport(repo, csv, 'cli'), null, 2));
}
process.exit(0);
