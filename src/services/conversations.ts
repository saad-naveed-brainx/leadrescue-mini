import { db } from '../db.js';
import { notFound } from '../middleware/errors.js';

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
    `SELECT id, direction, author, body, created_at AS "createdAt"
       FROM messages WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY created_at`,
    [tenantId, id],
  );
  return { ...conversation, messages };
}

/**
 * Switches a conversation to MANUAL (a person takes over) or back to AI.
 *
 * This UPDATE locks the conversation row. If processPendingAiReply is in the middle of sending
 * for this conversation, it holds that lock, so we wait here until it's done. When we answer,
 * the new mode is saved, and every AI step after that reads it. See services/aiReply.ts.
 */
export async function handoff(
  tenantId: string,
  id: string,
  mode: 'AI' | 'MANUAL',
): Promise<Conversation> {
  const { rows } = await db.query<Conversation>(
    `UPDATE conversations SET mode = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [tenantId, id, mode],
  );
  if (!rows[0]) throw notFound('Conversation');
  return rows[0];
}
