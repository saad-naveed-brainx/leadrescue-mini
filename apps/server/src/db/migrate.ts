import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

// Any constant works; it only has to be the same for every process running migrations.
const MIGRATION_LOCK_KEY = 727_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies every `NNNN_name.sql` file in `dir` that hasn't been applied yet, in name order,
 * each in its own transaction. Forward-only: there are no down migrations.
 * An applied file whose contents changed afterwards is an error, not something to re-run.
 */
export async function runMigrations(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    // Two processes starting at once (API and worker) must not both run the same migration.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was edited after it was applied; add a new migration instead`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// CLI: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { config } = await import('../config.js');
  const { createPool } = await import('./pool.js');
  const pool = createPool(config.DATABASE_URL);
  try {
    const { applied, skipped } = await runMigrations(pool);
    console.log(`migrations: ${applied.length} applied, ${skipped.length} already up to date`);
    for (const f of applied) console.log(`  applied ${f}`);
  } finally {
    await pool.end();
  }
}
