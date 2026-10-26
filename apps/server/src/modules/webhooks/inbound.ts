import { normalizePhone } from '@lr/shared';
import { z } from 'zod';
import { lockConversationForTx } from '../../db/locks.js';
import { type Pool, withTx } from '../../db/pool.js';
import type { Queryable } from '../../db/queryable.js';
import { logger } from '../../http/logger.js';
import { currentRequestId } from '../../http/requestContext.js';
import { cancelPendingJobs, enqueueJob } from '../../queue/enqueue.js';
import { recordAudit } from '../audit/repo.js';
import { type Keyword, classifyKeyword } from './keywords.js';

/** The fields of Twilio's inbound-message webhook we use. Twilio sends many more; they're kept in the receipt. */
export const TwilioInbound = z.object({
  MessageSid: z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/, 'not a Twilio message SID'),
  From: z.string().min(1).max(32),
  To: z.string().min(1).max(32),
  Body: z.string().max(1600).default(''),
});
export type TwilioInbound = z.infer<typeof TwilioInbound>;

export type InboundOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'unroutable' }
  | { outcome: 'ignored'; reason: string }
  | {
      outcome: 'processed';
      orgId: string;
      leadId: string;
      leadCreated: boolean;
      conversationId: string;
      messageId: string;
      keyword: Keyword | null;
      aiReplyJobId: string | null;
    };

/**
 * Handles one inbound SMS in a single transaction (PLAN.md §5.1). Either everything below is
 * committed together, or nothing is and Twilio's retry starts from scratch.
 *
 * Duplicates: the webhook receipt is inserted first. A retry of a message we already processed hits
 * the unique (provider, provider_event_id) and stops; a retry that arrives while the first attempt
 * is still running waits on that unique index, then sees the committed receipt and stops.
 */
export async function handleInboundSms(
  pool: Pool,
  msg: TwilioInbound,
  rawPayload: Record<string, unknown>,
): Promise<InboundOutcome> {
  const result = await withTx(pool, async (tx) => {
    const receipt = await tx.query<{ id: string }>(
      `INSERT INTO webhook_receipts (provider, provider_event_id, outcome, payload, correlation_id)
       VALUES ('twilio', $1, 'processed', $2, $3)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [msg.MessageSid, rawPayload, currentRequestId() ?? null],
    );
    const receiptId = receipt.rows[0]?.id;
    if (!receiptId) return { outcome: 'duplicate' } as const;

    const settle = (outcome: 'processed' | 'unroutable' | 'ignored', orgId: string | null = null) =>
      tx.query('UPDATE webhook_receipts SET outcome = $2, org_id = $3 WHERE id = $1', [
        receiptId,
        outcome,
        orgId,
      ]);

    // 1. The number that was texted decides the tenant. Nothing in the payload is trusted for it.
    const toE164 = normalizePhone(msg.To);
    const number = toE164
      ? (
          await tx.query<{ id: string; org_id: string }>(
            'SELECT id, org_id FROM phone_numbers WHERE e164 = $1 AND active',
            [toE164],
          )
        ).rows[0]
      : undefined;
    if (!number) {
      await settle('unroutable');
      return { outcome: 'unroutable' } as const;
    }
    const orgId = number.org_id;

    // 2. The sender, in the one format leads are stored and matched in.
    const fromE164 = normalizePhone(msg.From);
    if (!fromE164) {
      await settle('ignored', orgId);
      return { outcome: 'ignored', reason: 'sender is not a valid phone number' } as const;
    }

    // 3. Match the lead by phone within this tenant, or create it.
    const lead = (
      await tx.query<{ id: string; created: boolean }>(
        `INSERT INTO leads (org_id, phone_e164, source) VALUES ($1, $2, 'sms')
         ON CONFLICT (org_id, phone_e164) DO UPDATE SET updated_at = leads.updated_at
         RETURNING id, (xmax = 0) AS created`,
        [orgId, fromE164],
      )
    ).rows[0]!;

    const conversation = (
      await tx.query<{ id: string; mode: 'auto' | 'manual' }>(
        `INSERT INTO conversations (org_id, lead_id, phone_number_id, last_message_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (org_id, lead_id, channel) DO UPDATE SET last_message_at = now()
         RETURNING id, mode`,
        [orgId, lead.id, number.id],
      )
    ).rows[0]!;

    const message = (
      await tx.query<{ id: string }>(
        `INSERT INTO messages (org_id, conversation_id, direction, author, body, status, provider_message_id)
         VALUES ($1, $2, 'inbound', 'lead', $3, 'received', $4)
         RETURNING id`,
        [orgId, conversation.id, msg.Body, msg.MessageSid],
      )
    ).rows[0]!;

    // 4. Keywords change consent; anything else may get an automated reply.
    const keyword = classifyKeyword(msg.Body);

    // 5. The lead replied, so any "no reply yet" follow-up is no longer wanted. (STOP cancels
    //    everything itself, recording why.)
    if (keyword !== 'opt_out') {
      await cancelPendingJobs(tx, orgId, conversation.id, 'lead_replied', ['follow_up']);
    }

    let aiReplyJobId: string | null = null;
    if (keyword === 'opt_out') {
      await optOut(tx, orgId, conversation.id, fromE164, message.id, msg.Body);
    } else if (keyword === 'opt_in') {
      await optIn(tx, orgId, conversation.id, fromE164, message.id);
    } else if (keyword === null && conversation.mode === 'auto') {
      // Cheap early check only; the send step re-checks everything under the conversation lock.
      if (!(await isOptedOut(tx, orgId, fromE164))) {
        aiReplyJobId = await enqueueJob(tx, {
          orgId,
          conversationId: conversation.id,
          type: 'ai_reply',
          payload: { inboundMessageId: message.id },
          dedupeKey: `ai_reply:${message.id}`,
        });
      }
    }
    // HELP is answered by Twilio's own keyword handling, so it gets no automated reply here.

    await settle('processed', orgId);
    return {
      outcome: 'processed',
      orgId,
      leadId: lead.id,
      leadCreated: lead.created,
      conversationId: conversation.id,
      messageId: message.id,
      keyword,
      aiReplyJobId,
    } as const;
  });

  // Ids only: phone numbers and message text never go to the logs.
  logger.info({ messageSid: msg.MessageSid, ...withoutPii(result) }, 'inbound sms');
  return result;
}

function withoutPii(r: InboundOutcome) {
  return r.outcome === 'processed'
    ? { outcome: r.outcome, orgId: r.orgId, conversationId: r.conversationId, keyword: r.keyword }
    : r;
}

async function isOptedOut(tx: Queryable, orgId: string, phone: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM opt_outs WHERE org_id = $1 AND phone_e164 = $2 AND channel = 'sms' AND revoked_at IS NULL`,
    [orgId, phone],
  );
  return (rowCount ?? 0) > 0;
}

async function optOut(
  tx: Queryable,
  orgId: string,
  conversationId: string,
  phone: string,
  messageId: string,
  body: string,
) {
  // Same lock as the send step: a reply being sent right now finishes first, and every send that
  // checks after this commits sees the opt-out.
  await lockConversationForTx(tx, conversationId);
  const inserted = await tx.query(
    `INSERT INTO opt_outs (org_id, phone_e164, channel, keyword, source_message_id)
     VALUES ($1, $2, 'sms', $3, $4)
     ON CONFLICT (org_id, phone_e164, channel) WHERE revoked_at IS NULL DO NOTHING`,
    [orgId, phone, body.trim().toUpperCase().slice(0, 32), messageId],
  );
  const cancelled = await cancelPendingJobs(tx, orgId, conversationId, 'opted_out');
  // A repeated STOP from a number that is already opted out changes nothing, so it records nothing:
  // audit history is permanent and must only describe real changes.
  if (!inserted.rowCount) return;
  await recordAudit(tx, {
    orgId,
    actorType: 'webhook',
    action: 'opt_out.created',
    targetType: 'conversation',
    targetId: conversationId,
    metadata: { channel: 'sms', cancelledJobs: cancelled },
  });
}

async function optIn(
  tx: Queryable,
  orgId: string,
  conversationId: string,
  phone: string,
  messageId: string,
) {
  await lockConversationForTx(tx, conversationId);
  const { rowCount } = await tx.query(
    `UPDATE opt_outs SET revoked_at = now(), revoked_by_message_id = $3
      WHERE org_id = $1 AND phone_e164 = $2 AND channel = 'sms' AND revoked_at IS NULL`,
    [orgId, phone, messageId],
  );
  if (rowCount) {
    await recordAudit(tx, {
      orgId,
      actorType: 'webhook',
      action: 'opt_out.revoked',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { channel: 'sms' },
    });
  }
}
