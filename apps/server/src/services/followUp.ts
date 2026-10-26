import { db } from '../db.js';
import { loadForAutomation, reasonToSkip } from './conversations.js';
import { type Job, type JobResult, PermanentJobError } from './jobs.js';
import { sendAutomatedMessage } from './sendMessage.js';

/**
 * Handles a 'follow_up' job: one "just checking in" text, sent only if the customer hasn't
 * answered since our AI reply. Planned when that reply was sent (see sendMessage.ts).
 */
export async function handleFollowUp(job: Job): Promise<JobResult> {
  const afterMessageId = job.payload.afterMessageId;
  if (typeof afterMessageId !== 'string') {
    throw new PermanentJobError('job payload has no afterMessageId');
  }

  const conv = await loadForAutomation(job.orgId, job.conversationId);
  if (!conv) throw new PermanentJobError('conversation not found');
  const skip = reasonToSkip(conv);
  if (skip) return { outcome: 'cancelled', reason: skip };

  // Did the customer write back after our reply? Then no reminder is needed. (A new text already
  // cancels a waiting follow-up; this also covers one that was already running at the time.)
  const replied = await db.query(
    `SELECT 1 FROM messages
      WHERE org_id = $1 AND conversation_id = $2 AND direction = 'inbound'
        AND created_at > (SELECT created_at FROM messages WHERE org_id = $1 AND id = $3)
      LIMIT 1`,
    [job.orgId, job.conversationId, afterMessageId],
  );
  if (replied.rowCount) return { outcome: 'cancelled', reason: 'lead_replied' };

  const result = await sendAutomatedMessage({
    orgId: job.orgId,
    conversationId: job.conversationId,
    body: `Hi, just checking in from ${conv.businessName}. Are you still looking for help? Reply anytime.`,
    idempotencyKey: `follow_up:${afterMessageId}`,
    author: 'system',
    // No follow-up after a follow-up: one reminder, never a chain.
  });
  if (result.outcome === 'blocked') return { outcome: 'cancelled', reason: result.reason };
  return { outcome: 'done' };
}
