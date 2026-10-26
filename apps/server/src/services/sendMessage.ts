import type pg from 'pg';
import { config } from '../config.js';
import { db, transactionOn } from '../db.js';
import { logger } from '../logger.js';
import { crashHere } from '../utils/testHooks.js';
import { recordAudit } from './audit.js';
import { CONVERSATION_LOCK_KEY, reasonToSkip } from './conversations.js';
import { enqueueJob } from './jobs.js';
import { mockSms } from './mockSms.js';

// THE SEND GATE. Every automatic text leaves through sendAutomatedMessage and nowhere else.
//
// 1. Lock the conversation, so STOP, the Auto/Manual switch and closing the lead have to wait
//    until we're done (and we wait for them if they're already running).
// 2. Already sent with this key?  → don't send again.
//    Half-sent before a crash?     → ask the SMS service whether it went out, instead of guessing.
// 3. Final checks, read fresh while holding the lock: Auto mode, no STOP, lead not closed.
// 4. Write down "about to send" (status 'sending'), send, then write down "sent".
// 5. Unlock.

export interface AutomatedMessage {
  orgId: string;
  conversationId: string;
  body: string;
  /** One send per key, ever. For an AI reply: 'ai_reply:<the customer's message id>'. */
  idempotencyKey: string;
  author: 'ai' | 'system';
  /** True for an AI reply: schedule the one "just checking in" text, in the same step as "sent". */
  scheduleFollowUp?: boolean;
}

export type SendResult =
  | { outcome: 'sent'; messageId: string }
  | { outcome: 'already_sent'; messageId: string }
  | { outcome: 'blocked'; reason: string };

export async function sendAutomatedMessage(msg: AutomatedMessage): Promise<SendResult> {
  // One connection of our own: the lock belongs to this connection until we unlock it. If the
  // process crashes, the connection drops and Postgres releases the lock by itself.
  const conn = await db.connect();
  let unlockFailed = false;
  try {
    await conn.query(`SELECT pg_advisory_lock(${CONVERSATION_LOCK_KEY})`, [msg.conversationId]);
    return await sendWhileLocked(conn, msg);
  } finally {
    try {
      await conn.query(`SELECT pg_advisory_unlock(${CONVERSATION_LOCK_KEY})`, [msg.conversationId]);
    } catch {
      unlockFailed = true;
    }
    // A connection that might still hold the lock is closed instead of reused.
    conn.release(unlockFailed);
  }
}

async function sendWhileLocked(conn: pg.PoolClient, msg: AutomatedMessage): Promise<SendResult> {
  // ── 2. Has this exact message been handled before? ──
  const existing = (
    await conn.query<{ id: string; status: string }>(
      'SELECT id, status FROM messages WHERE org_id = $1 AND idempotency_key = $2',
      [msg.orgId, msg.idempotencyKey],
    )
  ).rows[0];

  if (existing && (existing.status === 'sent' || existing.status === 'delivered')) {
    return { outcome: 'already_sent', messageId: existing.id };
  }
  if (existing && existing.status === 'cancelled') {
    return { outcome: 'blocked', reason: 'cancelled earlier' };
  }
  if (existing && existing.status === 'sending') {
    // We crashed between "about to send" and "sent". Ask the SMS service whether it went out.
    const alreadySent = await mockSms.findByClientRef(msg.idempotencyKey);
    if (alreadySent) {
      await markSent(conn, msg, existing.id, alreadySent.sid);
      logger.info({ messageId: existing.id }, 'send reconciled: it had gone out before a crash');
      return { outcome: 'sent', messageId: existing.id };
    }
    // It never went out: carry on and send it now, after the checks below.
  }

  // ── 3. Final checks, read fresh under the lock ──
  const target = (
    await conn.query<SendTarget>(
      `SELECT c.mode, l.status AS "leadStatus", l.phone_e164 AS "to", p.e164 AS "from",
              EXISTS (SELECT 1 FROM opt_outs o
                       WHERE o.org_id = c.org_id AND o.phone_e164 = l.phone_e164
                         AND o.channel = 'sms' AND o.revoked_at IS NULL) AS "optedOut"
         FROM conversations c
         JOIN leads l ON l.org_id = c.org_id AND l.id = c.lead_id
         JOIN phone_numbers p ON p.org_id = c.org_id AND p.id = c.phone_number_id
        WHERE c.org_id = $1 AND c.id = $2`,
      [msg.orgId, msg.conversationId],
    )
  ).rows[0];

  const reason = whyBlocked(target);
  if (reason || !target?.to) {
    // Cancelled and recorded together, so the reason can never be lost.
    await transactionOn(conn, async (tx) => {
      if (existing) {
        await tx.query(`UPDATE messages SET status = 'cancelled' WHERE id = $1`, [existing.id]);
      }
      await recordAudit(tx, {
        orgId: msg.orgId,
        actorType: 'system',
        action: 'message.suppressed',
        targetType: 'conversation',
        targetId: msg.conversationId,
        metadata: { reason, idempotencyKey: msg.idempotencyKey },
      });
    });
    return { outcome: 'blocked', reason: reason ?? 'no_phone_number' };
  }

  // ── 4. Write down "about to send", send, write down "sent" ──
  // Saved before the send, so a crash in between leaves a trace that step 2 finds on the retry.
  const messageId =
    existing?.id ??
    (
      await conn.query<{ id: string }>(
        `INSERT INTO messages (org_id, conversation_id, direction, author, body, status, idempotency_key)
         VALUES ($1, $2, 'outbound', $3, $4, 'sending', $5)
         RETURNING id`,
        [msg.orgId, msg.conversationId, msg.author, msg.body, msg.idempotencyKey],
      )
    ).rows[0]!.id;

  crashHere('after_intent'); // test-only: see utils/testHooks.ts

  // If this throws, the message stays 'sending' and the job is retried; step 2 then checks with
  // the SMS service before trying again, so the customer never gets it twice.
  const { sid } = await mockSms.send({
    from: target.from,
    to: target.to,
    body: msg.body,
    clientRef: msg.idempotencyKey,
  });
  crashHere('after_provider_send'); // test-only: the text went out, but we never wrote "sent"
  await markSent(conn, msg, messageId, sid);
  return { outcome: 'sent', messageId };
}

interface SendTarget {
  mode: 'auto' | 'manual';
  leadStatus: string;
  to: string | null;
  from: string;
  optedOut: boolean;
}

/** The reason this message must not go out, or null if it may. */
function whyBlocked(target: SendTarget | undefined): string | null {
  if (!target) return 'conversation_not_found';
  const skip = reasonToSkip(target); // STOP, Manual mode, closed lead
  if (skip) return skip;
  if (!target.to) return 'no_phone_number';
  return null;
}

async function markSent(
  conn: pg.PoolClient,
  msg: AutomatedMessage,
  messageId: string,
  providerSid: string,
) {
  await transactionOn(conn, async (tx) => {
    await tx.query(
      `UPDATE messages SET status = 'sent', provider_message_id = $2, sent_at = now()
        WHERE id = $1`,
      [messageId, providerSid],
    );
    await tx.query(
      'UPDATE conversations SET last_message_at = now() WHERE org_id = $1 AND id = $2',
      [msg.orgId, msg.conversationId],
    );
    if (msg.scheduleFollowUp) {
      // Saved together with "sent": a reply that went out always has its follow-up planned.
      // One per AI reply (the key), and the follow-up itself schedules nothing, so no chains.
      await enqueueJob(tx, {
        orgId: msg.orgId,
        conversationId: msg.conversationId,
        type: 'follow_up',
        payload: { afterMessageId: messageId },
        dedupeKey: `follow_up:${messageId}`,
        runAt: new Date(Date.now() + config.FOLLOW_UP_DELAY_SECONDS * 1000),
      });
    }
  });
}
