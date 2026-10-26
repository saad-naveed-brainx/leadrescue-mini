import { config } from '../../src/config.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { seed } from '../../src/db/seed.js';

export { SEED, SEED_LEADS } from '../../src/db/seed.js';

/** A pool on the test database. Each test file creates one and ends it in afterAll. */
export function testPool(): Pool {
  return createPool(config.DATABASE_URL);
}

// Every table holding data (not schema_migrations). Kept in one place so a new table can't be
// forgotten by one test file and remembered by another.
const DATA_TABLES = [
  'mock_provider_messages',
  'webhook_receipts',
  'audit_events',
  'opt_outs',
  'workflow_jobs',
  'messages',
  'conversations',
  'leads',
  'phone_numbers',
  'organization_memberships',
  'users',
  'organizations',
];

/**
 * Empties every table and re-inserts the standard seed (2 tenants, 5 users, 33 leads).
 * Audit history is append-only even for TRUNCATE, so the guard is lifted for the reset only.
 */
export async function resetDb(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate');
    await client.query(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await client.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate');
    await seed(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Id of a seeded lead, looked up by name. */
export async function leadIdByName(pool: Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM leads WHERE name = $1', [name]);
  if (!rows[0]) throw new Error(`no seeded lead named ${name}`);
  return rows[0].id;
}

/** Creates a conversation for a lead on its tenant's seeded number. */
export async function createConversation(
  pool: Pool,
  orgId: string,
  leadId: string,
  phoneNumberId: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO conversations (org_id, lead_id, phone_number_id) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, leadId, phoneNumberId],
  );
  return rows[0]!.id;
}

/** Returns the Postgres error code a statement fails with, or null if it succeeds. */
export async function pgErrorCode(pool: Pool, sql: string, params: unknown[] = []) {
  try {
    await pool.query(sql, params);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

// Postgres error codes the schema tests expect.
export const PG = {
  FOREIGN_KEY: '23503',
  UNIQUE: '23505',
  CHECK: '23514',
  RAISE: 'P0001',
} as const;
