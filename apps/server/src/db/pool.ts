import pg from 'pg';
import { logger } from '../http/logger.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client losing its connection must not crash the process, but it must be visible.
  pool.on('error', (err) => logger.error({ err }, 'pg pool idle client error'));
  return pool;
}

/** Runs `fn` inside a transaction, committing on success and rolling back on any error. */
export async function withTx<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
