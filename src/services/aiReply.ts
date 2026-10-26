import { withTransaction } from '../db.js';
import { aiSender } from './aiSender.js';

export type AiReplyResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'conversation_not_found' | 'manual_mode' | 'nothing_pending' };

/**
 * Answers the customer's latest message with an AI reply, if the conversation is still in AI mode.
 *
 * Preventing a race with the hand-off (POST /conversations/:id/handoff):
 * 1. We lock the conversation row (SELECT ... FOR UPDATE) for the whole of this step.
 * 2. The hand-off changes that same row, so it has to wait for the lock. While we hold it, the
 *    mode can't change under us; and if the hand-off got there first, we wait for it and then
 *    read MANUAL.
 * 3. We read the mode only after taking the lock: immediately before the simulated send.
 * So once a hand-off to MANUAL has been confirmed (its answer sent back), no AI reply can go out.
 *
 * Duplicate AI work: the reply is saved with reply_to_message_id = the customer's message, which
 * is UNIQUE. Running this twice for the same message (a retry, two copies at once) sends once.
 *
 * Takes only a conversation id: the company comes from that conversation's own row, and every
 * query below is limited to it.
 */
export async function processPendingAiReply(conversationId: string): Promise<AiReplyResult> {
  return withTransaction(async (tx) => {
    // 1. Lock the conversation and read its mode, its company and the customer's number.
    const conversation = (
      await tx.query<{
        tenantId: string;
        mode: 'AI' | 'MANUAL';
        companyName: string;
        companyNumber: string;
        customerNumber: string;
      }>(
        `SELECT c.tenant_id AS "tenantId", c.mode, t.name AS "companyName",
                t.phone_number AS "companyNumber", l.phone AS "customerNumber"
           FROM conversations c
           JOIN tenants t ON t.id = c.tenant_id
           JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
          WHERE c.id = $1
            FOR UPDATE OF c`,
        [conversationId],
      )
    ).rows[0];
    if (!conversation) return { sent: false, reason: 'conversation_not_found' };

    // 2. The check that matters: read under the lock, right before sending.
    if (conversation.mode !== 'AI') return { sent: false, reason: 'manual_mode' };

    // 3. Is the customer's latest message still unanswered?
    const latest = (
      await tx.query<{ id: string; answered: boolean }>(
        `SELECT m.id,
                EXISTS (SELECT 1 FROM messages r WHERE r.reply_to_message_id = m.id) AS answered
           FROM messages m
          WHERE m.tenant_id = $1 AND m.conversation_id = $2 AND m.direction = 'inbound'
          ORDER BY m.created_at DESC
          LIMIT 1`,
        [conversation.tenantId, conversationId],
      )
    ).rows[0];
    if (!latest || latest.answered) return { sent: false, reason: 'nothing_pending' };

    // 4. Save the reply, then send it. If the send fails, the transaction is rolled back, the
    //    reply row disappears with it, and a later run can try again.
    const body = aiSender.writeReply(conversation.companyName);
    const reply = (
      await tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, author, body, reply_to_message_id)
         VALUES ($1, $2, 'outbound', 'ai', $3, $4)
         RETURNING id`,
        [conversation.tenantId, conversationId, body, latest.id],
      )
    ).rows[0]!;
    await aiSender.send({
      to: conversation.customerNumber,
      from: conversation.companyNumber,
      body,
    });
    return { sent: true, messageId: reply.id };
  });
}
