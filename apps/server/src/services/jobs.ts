import type { DbClient } from '../db.js';

export type JobType = 'ai_reply' | 'follow_up';

export interface NewJob {
  orgId: string;
  conversationId: string;
  type: JobType;
  payload: Record<string, unknown>;
  /** Same key → same job: a second job with this key is ignored. */
  dedupeKey: string;
  runAt?: Date;
  requestId?: string;
}

/**
 * Adds a job to the queue (the workflow_jobs table). Pass the transaction that saves the data the
 * job is about, so the job exists if and only if that data was saved.
 * Returns the job id, or null if a job with this dedupe key already existed.
 */
export async function enqueueJob(tx: DbClient, job: NewJob): Promise<string | null> {
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
      job.requestId ?? null,
    ],
  );
  return rows[0]?.id ?? null;
}

/** Cancels a conversation's jobs that haven't started. A job already running re-checks at send time. */
export async function cancelPendingJobs(
  tx: DbClient,
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
