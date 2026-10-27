import type pg from 'pg';
import { db } from '../db.js';

// THE CONVERSATION LOCK. Sending an AI reply and the hand-off both take it, so they never overlap.
//
// It is a PostgreSQL "advisory lock": a named lock that protects no particular row; we decide
// what it means. The name is a number made from the conversation id. Two kinds are used:
// - withConversationLock (the AI send): the lock belongs to the CONNECTION, not a transaction,
//   so it stays held while we commit "sending", call the provider, and commit "sent".
//   If the worker crashes, its connection drops and PostgreSQL releases the lock by itself.
// - lockConversationInTransaction (the hand-off): released automatically when its transaction ends.
// Both use the same name, so they wait for each other.

/** SQL turning a conversation id ($1) into the lock's number. One place, so both kinds match. */
const LOCK_NUMBER = `hashtextextended('conversation:' || $1::text, 0)`;

/**
 * Runs `work` on a connection of its own while holding the conversation's lock. Statements run on
 * `conn` commit one by one (or use BEGIN/COMMIT on it), and the lock is held throughout.
 */
export async function withConversationLock<T>(
  conversationId: string,
  work: (conn: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const conn = await db.connect();
  let unlocked = false;
  try {
    await conn.query(`SELECT pg_advisory_lock(${LOCK_NUMBER})`, [conversationId]);
    try {
      return await work(conn);
    } finally {
      await conn.query(`SELECT pg_advisory_unlock(${LOCK_NUMBER})`, [conversationId]);
      unlocked = true;
    }
  } finally {
    // If unlocking failed, the connection might still hold the lock: close it instead of reusing it.
    conn.release(!unlocked);
  }
}

/** Takes the same lock inside a transaction; released when the transaction ends. */
export async function lockConversationInTransaction(
  tx: pg.PoolClient,
  conversationId: string,
): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(${LOCK_NUMBER})`, [conversationId]);
}
