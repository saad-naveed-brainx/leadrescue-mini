import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

// Runs inside a throwaway schema so it never touches the real test schema.
const SCHEMA = 'migrate_runner_test';
const url = new URL(config.DATABASE_URL);
url.searchParams.set('options', `-c search_path=${SCHEMA}`);
const pool = createPool(url.toString());

let dir: string;
beforeEach(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  dir = await mkdtemp(path.join(tmpdir(), 'lr-migrations-'));
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
  await rm(dir, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('applies new files in order, then skips them on the next run', async () => {
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    await writeFile(path.join(dir, '0002_b.sql'), 'CREATE TABLE b (a_id int);');
    await writeFile(path.join(dir, 'notes.txt'), 'ignored');

    expect(await runMigrations(pool, dir)).toEqual({
      applied: ['0001_a.sql', '0002_b.sql'],
      skipped: [],
    });
    expect(await runMigrations(pool, dir)).toEqual({
      applied: [],
      skipped: ['0001_a.sql', '0002_b.sql'],
    });
  });

  it('rolls back a failing migration completely', async () => {
    await writeFile(path.join(dir, '0001_bad.sql'), 'CREATE TABLE c (id int); SELECT broken(;');
    await expect(runMigrations(pool, dir)).rejects.toThrow(/0001_bad.sql failed/);
    const { rows } = await pool.query(`SELECT to_regclass('${SCHEMA}.c') AS t`);
    expect(rows[0].t).toBeNull();
  });

  it('refuses to continue when an applied file was edited', async () => {
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    await runMigrations(pool, dir);
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id bigint);');
    await expect(runMigrations(pool, dir)).rejects.toThrow(/edited after it was applied/);
  });
});
