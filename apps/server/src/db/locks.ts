import type { Queryable } from './queryable.js';

/**
 * The per-conversation lock (PLAN.md §5.4). Everything that decides whether an automated message
 * may go out takes it: the send step, the Auto/Manual toggle, STOP handling and closing a lead.
 * Holding it means none of the others can change their answer until you are done.
 *
 * This variant is released automatically when the surrounding transaction ends.
 */
export async function lockConversationForTx(tx: Queryable, conversationId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('conv:' || $1::text, 0))`, [
    conversationId,
  ]);
}
