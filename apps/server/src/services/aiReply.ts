import { db } from '../db.js';
import { type Job, type JobResult, PermanentJobError } from './jobs.js';
import { loadForAutomation, reasonToSkip } from './conversations.js';
import { mockAi } from './mockAi.js';
import { sendAutomatedMessage } from './sendMessage.js';

const MAX_REPLY_LENGTH = 480; // three SMS segments
const HISTORY_SIZE = 10; // how many recent messages the AI gets to see

/** Handles an 'ai_reply' job: write a reply to the customer's message and send it. */
export async function handleAiReply(job: Job): Promise<JobResult> {
  const inboundMessageId = job.payload.inboundMessageId;
  if (typeof inboundMessageId !== 'string') {
    throw new PermanentJobError('job payload has no inboundMessageId');
  }

  // 1. Quick checks before asking the AI. (The send gate checks again under the lock; these only
  //    save an AI call that would be thrown away.)
  const conv = await loadForAutomation(job.orgId, job.conversationId);
  if (!conv) throw new PermanentJobError('conversation not found');
  const skip = reasonToSkip(conv);
  if (skip) return { outcome: 'cancelled', reason: skip };

  // The customer sent another message after this one, and that message has its own reply job.
  // Answer only the latest, so they get one reply instead of two in a row.
  const newer = await db.query(
    `SELECT 1 FROM workflow_jobs
      WHERE org_id = $1 AND conversation_id = $2 AND type = 'ai_reply' AND id <> $3
        AND created_at > $4 AND status IN ('pending', 'running', 'succeeded')
      LIMIT 1`,
    [job.orgId, job.conversationId, job.id, job.createdAt],
  );
  if (newer.rowCount) return { outcome: 'cancelled', reason: 'superseded' };

  // 2. The conversation so far. Filtered by business and conversation, so the AI only ever sees
  //    this customer's messages with this business.
  const { rows: messages } = await db.query<{
    author: 'lead' | 'ai' | 'human' | 'system';
    body: string;
  }>(
    `SELECT author, body FROM (
       SELECT author, body, created_at FROM messages
        WHERE org_id = $1 AND conversation_id = $2
        ORDER BY created_at DESC LIMIT $3) recent
      ORDER BY created_at`,
    [job.orgId, job.conversationId, HISTORY_SIZE],
  );

  // 3. Ask the AI, and check what it wrote before it can reach a customer.
  const reply = (await mockAi.generateReply({ businessName: conv.businessName, messages })).trim();
  if (!reply || reply.length > MAX_REPLY_LENGTH || looksLikeLink(reply)) {
    throw new PermanentJobError('AI reply failed validation (empty, too long or contains a link)');
  }

  // 4. Send it through the gate.
  const result = await sendAutomatedMessage({
    orgId: job.orgId,
    conversationId: job.conversationId,
    body: reply,
    idempotencyKey: `ai_reply:${inboundMessageId}`,
    author: 'ai',
    scheduleFollowUp: true,
  });
  if (result.outcome === 'blocked') return { outcome: 'cancelled', reason: result.reason };
  return { outcome: 'done' };
}

/** True if the text contains anything link-like: http(s)://, www., tel:, mailto: or a bare domain
 *  such as example.com/pay. The AI must not send customers links we didn't write. */
export function looksLikeLink(text: string): boolean {
  return (
    /\b(https?:\/\/|www\.|tel:|mailto:)/i.test(text) ||
    /\b[a-z0-9-]+\.(com|net|org|io|co|us|info|biz|app|dev|me|ly|link|test)\b/i.test(text)
  );
}
