import { type DbClient, db, withTransaction } from '../db.js';
import { recordAudit } from './audit.js';

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

// ─────────────────────────────── the worker's side ───────────────────────────────
//
// A job's life:  pending → running → succeeded
//                                  → cancelled  (no longer wanted: STOP, Manual mode, ...)
//                                  → pending    (failed; try again later)
//                                  → dead       (failed too many times; a person must look)

/** A job the worker has taken. */
export interface Job {
  id: string;
  orgId: string;
  conversationId: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  requestId: string | null;
}

/** What a job handler reports back: done, or no longer needed (with the reason). */
export type JobResult = { outcome: 'done' } | { outcome: 'cancelled'; reason: string };

/** Thrown when retrying can't help (bad data, invalid AI output): the job goes straight to dead. */
export class PermanentJobError extends Error {}

const JOB_COLUMNS = `id, org_id AS "orgId", conversation_id AS "conversationId", type, payload,
                     attempts, max_attempts AS "maxAttempts", created_at AS "createdAt",
                     correlation_id AS "requestId"`;

/**
 * Takes up to `limit` jobs that are due, and writes the worker's name and a deadline ("lease") on
 * them. SKIP LOCKED means two workers asking at the same moment never get the same job.
 */
export async function claimJobs(workerId: string, limit: number, leaseSeconds: number) {
  const { rows } = await db.query<Job>(
    `UPDATE workflow_jobs
        SET status = 'running', locked_by = $1, locked_until = now() + make_interval(secs => $3),
            attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM workflow_jobs
                    WHERE status = 'pending' AND run_at <= now()
                    ORDER BY run_at
                    LIMIT $2
                    FOR UPDATE SKIP LOCKED)
      RETURNING ${JOB_COLUMNS}`,
    [workerId, limit, leaseSeconds],
  );
  return rows;
}

// Every finishing update below checks `locked_by = workerId`. If this worker was too slow and its
// lease was handed to another worker, its late update changes nothing ("fencing").

export async function completeJob(job: Job, workerId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE workflow_jobs
        SET status = 'succeeded', locked_by = NULL, locked_until = NULL,
            updated_at = now(), finished_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [job.id, workerId],
  );
  return rowCount === 1;
}

export async function cancelJob(job: Job, workerId: string, reason: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE workflow_jobs
        SET status = 'cancelled', cancel_reason = $3, locked_by = NULL, locked_until = NULL,
            updated_at = now(), finished_at = now()
      WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
    [job.id, workerId, reason],
  );
  return rowCount === 1;
}

/** Wait 2, 4, 8, 16... seconds between tries (at most 60), plus up to 1 s of random spread. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(2 ** attempts, 60) + Math.random();
}

/** The job failed: try again later, or give up (dead) if it has used all its attempts. */
export async function failJob(job: Job, workerId: string, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const giveUp = err instanceof PermanentJobError || job.attempts >= job.maxAttempts;

  if (!giveUp) {
    await db.query(
      `UPDATE workflow_jobs
          SET status = 'pending', locked_by = NULL, locked_until = NULL, last_error = $3,
              run_at = now() + make_interval(secs => $4), updated_at = now()
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [job.id, workerId, message, retryDelaySeconds(job.attempts)],
    );
    return;
  }

  await withTransaction(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE workflow_jobs
          SET status = 'dead', locked_by = NULL, locked_until = NULL, last_error = $3,
              updated_at = now(), finished_at = now()
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [job.id, workerId, message],
    );
    if (rowCount === 1) {
      await recordAudit(tx, {
        orgId: job.orgId,
        actorType: 'system',
        action: 'job.dead',
        targetType: 'job',
        targetId: job.id,
        metadata: { type: job.type, attempts: job.attempts },
      });
    }
  });
}

/**
 * Rescues jobs whose worker crashed: their deadline passed while still "running". They go back to
 * pending, or to dead if they've already used all their attempts (a job that crashes the worker
 * every time must not loop forever). Returns how many were rescued.
 */
export async function reapExpiredJobs(): Promise<number> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; orgId: string; type: JobType; status: string }>(
      `UPDATE workflow_jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
              finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
              locked_by = NULL, locked_until = NULL, updated_at = now(),
              last_error = 'worker lease expired'
        WHERE status = 'running' AND locked_until < now()
        RETURNING id, org_id AS "orgId", type, status`,
    );
    for (const job of rows.filter((r) => r.status === 'dead')) {
      await recordAudit(tx, {
        orgId: job.orgId,
        actorType: 'system',
        action: 'job.dead',
        targetType: 'job',
        targetId: job.id,
        metadata: { type: job.type, reason: 'lease expired on the last attempt' },
      });
    }
    return rows.length;
  });
}

/** How many jobs are waiting, being worked on, or dead: shown by /health/ready. */
export async function queueStats() {
  const { rows } = await db.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM workflow_jobs
      WHERE status IN ('pending', 'running', 'dead') GROUP BY status`,
  );
  const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
  return { pending: count('pending'), running: count('running'), dead: count('dead') };
}

// ─────────────────────────────── dead jobs (npm run jobs) ───────────────────────────────

export interface DeadJob {
  id: string;
  orgId: string;
  type: JobType;
  attempts: number;
  lastError: string | null;
  finishedAt: Date;
}

/** Jobs that failed for good, newest first. */
export async function listDeadJobs(): Promise<DeadJob[]> {
  const { rows } = await db.query<DeadJob>(
    `SELECT id, org_id AS "orgId", type, attempts, last_error AS "lastError",
            finished_at AS "finishedAt"
       FROM workflow_jobs WHERE status = 'dead'
      ORDER BY finished_at DESC`,
  );
  return rows;
}

/**
 * Gives a dead job a fresh start: back to waiting, with a full set of attempts. Recorded in the
 * audit history with who asked. Returns false if there is no dead job with this id. Safe for
 * replies: the send gate still refuses anything already sent, opted out or taken over.
 */
export async function retryDeadJob(jobId: string, requestedBy: string): Promise<boolean> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{ orgId: string; type: JobType }>(
      `UPDATE workflow_jobs
          SET status = 'pending', attempts = 0, run_at = now(), finished_at = NULL,
              updated_at = now()
        WHERE id = $1 AND status = 'dead'
        RETURNING org_id AS "orgId", type`,
      [jobId],
    );
    const job = rows[0];
    if (!job) return false;
    await recordAudit(tx, {
      orgId: job.orgId,
      actorType: 'system',
      action: 'job.retried',
      targetType: 'job',
      targetId: jobId,
      metadata: { type: job.type, requestedBy },
    });
    return true;
  });
}
