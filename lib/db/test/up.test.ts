import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_DIR, migrationHash, readJournal } from '../src/up.js';

describe('db:up baseline', () => {
  it('knows a fingerprint for every migration in the journal, in order', () => {
    const src = readFileSync(path.join(MIGRATIONS_DIR, '..', 'src', 'up.ts'), 'utf8');
    const entries = readJournal();
    expect(entries.length).toBeGreaterThanOrEqual(9);
    for (const e of entries) expect(src, `FINGERPRINTS is missing ${e.tag}`).toContain(`'${e.tag}':`);
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    expect(migrationHash(MIGRATIONS_DIR, entries[0]!.tag)).toMatch(/^[0-9a-f]{64}$/);
  });
});
