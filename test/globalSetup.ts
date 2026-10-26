import pg from 'pg';
import { runMigrations } from '../src/scripts/migrate.js';
import { TEST_DATABASE_URL } from './testDatabaseUrl.js';

// Once per `npm test`: rebuild the test database's schema from the migrations, so tests always run
// against exactly what the migration files describe (including any edits made while developing).
export default async function setup() {
  // This wipes the whole schema, so refuse anything that isn't clearly a disposable test database.
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to reset "${dbName}": TEST_DATABASE_URL must name a *_test database`);
  }
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public');
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
