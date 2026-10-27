import type pg from 'pg';
import { db } from '../db.js';
import { aiSender } from './aiSender.js';
import { withConversationLock } from './conversationLock.js';

export type AiReplyResult =
  | { sent: true; messageId: string; recoveredAfterCrash?: true }
  | { sent: false; reason: 'conversation_not_found' | 'manual_mode' | 'nothing_pending' };

/**
 * Answers the customer's latest message with an AI reply, if the conversation is in AI mode.
 * Called by the background worker for each ai_reply job. In four steps:
 *
 * A. Write the reply (the slow AI call) WITHOUT any lock, so a hand-off never waits for the AI.
 * B. Take the conversation lock. Check, fresh: still AI mode? still unanswered? Save the reply
 *    as 'sending' and commit, so the plan to send survives a crash.
 * C. Send it through the SMS provider.
 * D. Save it as 'sent' with the provider's id. Release the lock.
 *
 * The hand-off takes the same lock, so it can't happen between B and D: once a hand-off to
 * MANUAL has answered, no AI reply goes out.
 *
 * A crash after C but before D leaves the reply 'sending'. The job is retried, finds that row,
 * and asks the provider whether it went out (aiSender.findSent) before sending: never twice.
 *
 * Takes only a conversation id: the company comes from that conversation's own row, and every
 * query below is limited to it.
 */
export async function processPendingAiReply(conversationId: string): Promise<AiReplyResult> {
  // ── A. Look, without a lock, and write the reply ──
  const before = await loadState(db, conversationId);
  if (!before) return { sent: false, reason: 'conversation_not_found' };
  // Early exits that save an AI call. They are checked again under the lock in step B.
  if (before.mode !== 'AI' && before.replyStatus !== 'sending') {
    return { sent: false, reason: 'manual_mode' };
  }
  if (
    !before.latestMessageId ||
    before.replyStatus === 'sent' ||
    before.replyStatus === 'cancelled'
  ) {
    return { sent: false, reason: 'nothing_pending' };
  }
  const body = before.replyBody ?? (await aiSender.writeReply(before.companyName));

  return withConversationLock(conversationId, async (conn) => {
    // ── B. Check again under the lock: nothing can change the mode until we are done ──
    const now = await loadState(conn, conversationId);
    if (!now) return { sent: false, reason: 'conversation_not_found' };
    // A newer customer message arrived while the AI was writing: its own job answers it.
    if (now.latestMessageId !== before.latestMessageId) {
      return { sent: false, reason: 'nothing_pending' };
    }
    if (now.replyStatus === 'sent' || now.replyStatus === 'cancelled') {
      return { sent: false, reason: 'nothing_pending' };
    }

    let replyId = now.replyId;
    if (replyId && now.replyStatus === 'sending') {
      // A previous attempt saved 'sending' and then stopped (crashed, or the send failed).
      // Did the provider get it? If so, only the record is missing: complete it, don't resend.
      const sid = await aiSender.findSent(replyId);
      if (sid) {
        await markSent(conn, replyId, sid);
        return { sent: true, messageId: replyId, recoveredAfterCrash: true };
      }
    }

    // The check that matters, read under the lock right before sending.
    if (now.mode !== 'AI') {
      // A reply that was saved but never went out is cancelled, not left 'sending'.
      if (replyId) {
        await conn.query(`UPDATE messages SET send_status = 'cancelled' WHERE id = $1`, [replyId]);
      }
      return { sent: false, reason: 'manual_mode' };
    }

    if (!replyId) {
      // Committed straight away (no transaction around it): from here on, a crash leaves a trace.
      // reply_to_message_id is UNIQUE: at most one reply per customer message, ever.
      replyId = (
        await conn.query<{ id: string }>(
          `INSERT INTO messages
             (tenant_id, conversation_id, direction, author, body, reply_to_message_id, send_status)
           VALUES ($1, $2, 'outbound', 'ai', $3, $4, 'sending')
           RETURNING id`,
          [now.tenantId, conversationId, body, now.latestMessageId],
        )
      ).rows[0]!.id;
    }

    // ── C. Send ──  (if this throws, the reply stays 'sending' and the job is retried)
    const { sid } = await aiSender.send({
      to: now.customerNumber,
      from: now.companyNumber,
      body,
      clientRef: replyId,
    });

    // ── D. Record it ──
    await markSent(conn, replyId, sid);
    return { sent: true, messageId: replyId };
  });
}

interface State {
  tenantId: string;
  mode: 'AI' | 'MANUAL';
  companyName: string;
  companyNumber: string;
  customerNumber: string;
  /** The customer's latest message, and our reply to it (if any). */
  latestMessageId: string | null;
  replyId: string | null;
  replyStatus: 'sending' | 'sent' | 'cancelled' | null;
  replyBody: string | null;
}

/** The conversation, its company and customer, and the latest customer message with its reply. */
async function loadState(
  client: pg.Pool | pg.PoolClient,
  conversationId: string,
): Promise<State | null> {
  const { rows } = await client.query<State>(
    `SELECT c.tenant_id AS "tenantId", c.mode, t.name AS "companyName",
            t.phone_number AS "companyNumber", l.phone AS "customerNumber",
            latest.id AS "latestMessageId", reply.id AS "replyId",
            reply.send_status AS "replyStatus", reply.body AS "replyBody"
       FROM conversations c
       JOIN tenants t ON t.id = c.tenant_id
       JOIN leads l ON l.tenant_id = c.tenant_id AND l.id = c.lead_id
       LEFT JOIN LATERAL (
         SELECT m.id FROM messages m
          WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id AND m.direction = 'inbound'
          ORDER BY m.created_at DESC
          LIMIT 1
       ) latest ON true
       LEFT JOIN messages reply
              ON reply.tenant_id = c.tenant_id AND reply.reply_to_message_id = latest.id
      WHERE c.id = $1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

async function markSent(conn: pg.PoolClient, replyId: string, providerSid: string) {
  await conn.query(
    `UPDATE messages SET send_status = 'sent', provider_message_id = $2, sent_at = now()
      WHERE id = $1`,
    [replyId, providerSid],
  );
}
