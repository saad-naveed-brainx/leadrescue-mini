import pg from 'pg';
import { config } from './config.js';

// One shared set of database connections for the whole process. Everything imports this.
export const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

// A connection dropping while idle must not crash the server, but we want to see it.
db.on('error', (err) => console.error('database connection error', err));

/**
 * Runs `work` as one transaction: if it finishes, all of its changes are saved together (COMMIT);
 * if it throws, none of them are (ROLLBACK).
 */
export async function withTransaction<T>(work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
