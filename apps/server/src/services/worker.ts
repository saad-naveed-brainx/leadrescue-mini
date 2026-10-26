import { logger } from '../logger.js';
import { handleAiReply } from './aiReply.js';
import {
  type Job,
  type JobResult,
  type JobType,
  PermanentJobError,
  cancelJob,
  claimJobs,
  completeJob,
  failJob,
  reapExpiredJobs,
} from './jobs.js';

// How long a worker may hold a job before others assume it crashed and take it over.
const LEASE_SECONDS = 60;
const BATCH_SIZE = 5;

// Which function handles which kind of job.
const HANDLERS: Record<JobType, (job: Job) => Promise<JobResult>> = {
  ai_reply: handleAiReply,
  follow_up: async () => {
    throw new PermanentJobError('follow-up jobs are handled from M5');
  },
};

/** Runs one job and records how it ended: done, cancelled, or failed (retry or dead). */
export async function runJob(job: Job, workerId: string): Promise<void> {
  try {
    const result = await HANDLERS[job.type](job);
    const stillOurs =
      result.outcome === 'cancelled'
        ? await cancelJob(job, workerId, result.reason)
        : await completeJob(job, workerId);
    if (stillOurs) {
      logger.info({ jobId: job.id, type: job.type, ...result }, 'job finished');
    } else {
      // Our lease ran out and another worker took the job over; its result is the one that counts.
      logger.warn({ jobId: job.id, type: job.type }, 'job finished after its lease was lost');
    }
  } catch (err) {
    await failJob(job, workerId, err);
    logger.warn({ jobId: job.id, type: job.type, attempts: job.attempts, err }, 'job failed');
  }
}

/** One round of the worker: rescue crashed jobs, take a batch of due jobs, run them one by one.
 *  Returns how many jobs it ran. */
export async function runWorkerOnce(workerId: string): Promise<number> {
  await reapExpiredJobs();
  const jobs = await claimJobs(workerId, BATCH_SIZE, LEASE_SECONDS);
  for (const job of jobs) {
    await runJob(job, workerId);
  }
  return jobs.length;
}
