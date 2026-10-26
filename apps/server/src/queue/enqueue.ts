import type { Queryable } from '../db/queryable.js';
import { currentRequestId } from '../http/requestContext.js';

export type JobType = 'ai_reply' | 'follow_up';

export interface NewJob {
  orgId: string;
  conversationId: string;
  type: JobType;
  payload: Record<string, unknown>;
  /** Same key → same job: a second enqueue with this key is ignored. */
  dedupeKey: string;
  runAt?: Date;
}

/**
 * Adds a job to the PostgreSQL-backed queue. Call it with the transaction that writes the data the
 * job is about, so the job exists if and only if that data was committed.
 * Returns the job id, or null if a job with this dedupe key already existed.
 */
export async function enqueueJob(tx: Queryable, job: NewJob): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO workflow_jobs (org_id, conversation_id, type, payload, dedupe_key, run_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, now()), $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      job.orgId,
      job.conversationId,
      job.type,
      job.payload,
      job.dedupeKey,
      job.runAt ?? null,
      currentRequestId() ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

/** Cancels a conversation's jobs that haven't started. A job already running re-checks at send time. */
export async function cancelPendingJobs(
  tx: Queryable,
  orgId: string,
  conversationId: string,
  reason: string,
  types: JobType[] = ['ai_reply', 'follow_up'],
): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE workflow_jobs
        SET status = 'cancelled', cancel_reason = $4, updated_at = now(), finished_at = now()
      WHERE org_id = $1 AND conversation_id = $2 AND status = 'pending' AND type = ANY($3)`,
    [orgId, conversationId, types, reason],
  );
  return rowCount ?? 0;
}
