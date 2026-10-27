import type pg from 'pg';
import { db } from '../db.js';

// THE QUEUE. Every piece of background work is a row in the `jobs` table, and all queue SQL is in
// this file. The rest of the app only calls enqueueJob, claimJobs, finishJob, failJob and
// releaseExpiredJobs, so the table could be replaced by Redis/SQS here without touching anything else.

export type JobType = 'ai_reply';

export interface Job {
  id: string;
  tenantId: string;
  conversationId: string;
  type: JobType;
  /** Which attempt this is (1 = first). Also proves we still own the job when we finish it. */
  attempts: number;
  maxAttempts: number;
}

/**
 * Adds a job. Takes the caller's transaction (`tx`), so the job is saved together with whatever
 * needs it (e.g. the incoming message): both or neither.
 * The same dedupeKey twice adds nothing the second time.
 */
export async function enqueueJob(
  tx: pg.PoolClient,
  job: { tenantId: string; conversationId: string; type: JobType; dedupeKey: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO jobs (tenant_id, conversation_id, type, dedupe_key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [job.tenantId, job.conversationId, job.type, job.dedupeKey],
  );
}

/**
 * Takes up to `limit` due jobs for this worker and marks them running until now + leaseSeconds.
 *
 * FOR UPDATE SKIP LOCKED is what lets many workers run in parallel: each one locks the rows it
 * picks, and the others skip those rows instead of waiting for them. So no job is ever given to
 * two workers, and no worker waits for another.
 */
export async function claimJobs(limit: number, leaseSeconds: number): Promise<Job[]> {
  const { rows } = await db.query<Job>(
    `UPDATE jobs
        SET status = 'running', attempts = attempts + 1,
            locked_until = now() + make_interval(secs => $2), updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'pending' AND run_at <= now()
         ORDER BY run_at
         LIMIT $1
           FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id AS "tenantId", conversation_id AS "conversationId", type,
                attempts, max_attempts AS "maxAttempts"`,
    [limit, leaseSeconds],
  );
  return rows;
}

/**
 * Marks a job done. `AND attempts = $2` makes sure we still own it: if our claim expired and
 * another worker took the job over, attempts has gone up and this changes nothing.
 */
export async function finishJob(job: Job): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running' AND attempts = $2`,
    [job.id, job.attempts],
  );
  return rowCount === 1;
}

/** Wait before retry: 2, 4, 8, 16, ... seconds, at most 60. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(2 ** attempts, 60);
}

/**
 * The job threw. Try again later (after retryDelaySeconds), or give up (status 'failed') once it
 * has had max_attempts tries. Same ownership check as finishJob.
 */
export async function failJob(job: Job, error: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            run_at = now() + make_interval(secs => $3),
            locked_until = NULL, last_error = $4, updated_at = now()
      WHERE id = $1 AND status = 'running' AND attempts = $2`,
    [job.id, job.attempts, retryDelaySeconds(job.attempts), error.slice(0, 1000)],
  );
  return rowCount === 1;
}

/**
 * Jobs whose worker crashed (claim expired) go back to pending for another worker, or to failed
 * if they have used all their attempts. Returns how many were released.
 */
export async function releaseExpiredJobs(): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            locked_until = NULL, last_error = 'worker stopped before finishing', updated_at = now()
      WHERE status = 'running' AND locked_until < now()`,
  );
  return rowCount ?? 0;
}

/** Deletes finished jobs older than `olderThanHours`, so the table stays small. */
export async function deleteOldDoneJobs(olderThanHours: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - make_interval(hours => $1)`,
    [olderThanHours],
  );
  return rowCount ?? 0;
}
