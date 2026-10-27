import { db, withTransaction } from '../db.js';
import { AppError, notFound } from '../middleware/errors.js';
import { lockConversationInTransaction } from './conversationLock.js';

export interface Conversation {
  id: string;
  leadId: string;
  mode: 'AI' | 'MANUAL';
  updatedAt: Date;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  author: 'customer' | 'ai';
  body: string;
  /** Outgoing only: 'sending' until the provider has it, then 'sent'. null for incoming. */
  sendStatus: 'sending' | 'sent' | null;
  createdAt: Date;
}

const COLUMNS = `id, lead_id AS "leadId", mode, updated_at AS "updatedAt"`;

/** A conversation and its messages, oldest first. Limited to the caller's company. */
export async function getConversation(tenantId: string, id: string) {
  const conversation = (
    await db.query<Conversation>(
      `SELECT ${COLUMNS} FROM conversations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )
  ).rows[0];
  if (!conversation) throw notFound('Conversation');

  const { rows: messages } = await db.query<Message>(
    // Cancelled replies never went out, so they are not part of the conversation.
    `SELECT id, direction, author, body, send_status AS "sendStatus", created_at AS "createdAt"
       FROM messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND send_status IS DISTINCT FROM 'cancelled'
      ORDER BY created_at`,
    [tenantId, id],
  );
  return { ...conversation, messages };
}

/** How long a hand-off waits for an AI send in progress before answering "busy, try again". */
const HANDOFF_LOCK_TIMEOUT = '5s';

/**
 * Switches a conversation to MANUAL (a person takes over) or back to AI.
 *
 * It takes the conversation lock first (the same one the AI send holds from its final check
 * until the SMS is recorded as sent). So if a reply is being sent right now, the hand-off waits
 * for it; once the hand-off has answered, every AI send after it reads the new mode.
 * See services/aiReply.ts. If a send holds the lock for more than 5 seconds, answer 503 instead
 * of keeping the staff member waiting.
 */
export async function handoff(
  tenantId: string,
  id: string,
  mode: 'AI' | 'MANUAL',
): Promise<Conversation> {
  try {
    return await withTransaction(async (tx) => {
      // Another company's (or a made-up) id: 404 straight away, without touching any lock.
      const found = await tx.query('SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        id,
      ]);
      if (found.rowCount === 0) throw notFound('Conversation');

      await tx.query(`SET LOCAL lock_timeout = '${HANDOFF_LOCK_TIMEOUT}'`);
      await lockConversationInTransaction(tx, id);

      const { rows } = await tx.query<Conversation>(
        `UPDATE conversations SET mode = $3, updated_at = now()
          WHERE tenant_id = $1 AND id = $2
          RETURNING ${COLUMNS}`,
        [tenantId, id, mode],
      );
      return rows[0]!;
    });
  } catch (err) {
    // 55P03 = PostgreSQL gave up waiting for the lock (lock_timeout above).
    if ((err as { code?: string }).code === '55P03') {
      throw new AppError(503, 'CONVERSATION_BUSY', 'A reply is being sent; try again in a moment');
    }
    throw err;
  }
}
