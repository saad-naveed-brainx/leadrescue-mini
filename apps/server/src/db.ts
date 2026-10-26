import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// One shared set of database connections for the whole process. Everything imports this.
export const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

// A connection dropping while idle must not crash the server, but we want to see it in the logs.
db.on('error', (err) => logger.error({ err }, 'database connection error'));

// Either the shared pool or one connection inside a transaction. Query functions that may run
// inside a transaction take this, so the caller decides which one to pass.
export type DbClient = pg.Pool | pg.PoolClient;

/**
 * Runs `work` as one transaction: if it finishes, all of its changes are saved together (COMMIT);
 * if it throws, none of them are (ROLLBACK).
 */
export async function withTransaction<T>(work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    return await transactionOn(tx, work);
  } finally {
    tx.release();
  }
}

/** The same, on a connection you already hold (the send gate keeps its own for the lock). */
export async function transactionOn<T>(
  conn: pg.PoolClient,
  work: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  await conn.query('BEGIN');
  try {
    const result = await work(conn);
    await conn.query('COMMIT');
    return result;
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
