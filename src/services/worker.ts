import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { processPendingAiReply } from './aiReply.js';
import {
  type Job,
  claimJobs,
  deleteOldDoneJobs,
  failJob,
  finishJob,
  releaseExpiredJobs,
} from './queue.js';

/**
 * Does one job. Success → done. An error → retried later, or failed after max attempts.
 *
 * Running the same job twice is safe: processPendingAiReply locks the conversation and the
 * database allows one AI reply per customer message. That matters if a slow job outlives its
 * claim and a second worker takes it over.
 */
export async function runJob(job: Job): Promise<void> {
  try {
    switch (job.type) {
      case 'ai_reply':
        // The mode (AI / MANUAL) is checked inside, under the conversation lock, right before
        // sending. A MANUAL conversation finishes the job without sending anything.
        await processPendingAiReply(job.conversationId);
        break;
    }
    await finishJob(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`job ${job.id} attempt ${job.attempts} failed: ${message}`);
    await failJob(job, message);
  }
}

/**
 * One round, used by tests and scripts: hand back crashed workers' jobs, then take up to `limit`
 * due jobs and run them all at the same time. Returns how many jobs it ran.
 */
export async function runWorkerOnce(limit = 10): Promise<number> {
  await releaseExpiredJobs();
  const jobs = await claimJobs(limit, config.JOB_LEASE_SECONDS);
  await Promise.all(jobs.map(runJob));
  return jobs.length;
}

/**
 * The long-running worker. It runs `concurrency` slots side by side; each slot takes one job,
 * does it, and takes the next. A slow AI call holds up only its own slot. Start more worker
 * processes to go further: they share the jobs table and never take the same job.
 */
export function startWorker(options: { concurrency: number; pollMs: number }) {
  let stopping = false;
  // Cancels idle waits when stop() is called, so stopping doesn't wait for a sleep to end.
  const stopSignal = new AbortController();
  const pause = (ms: number) => sleep(ms, undefined, { signal: stopSignal.signal }).catch(() => {});

  async function slot() {
    while (!stopping) {
      try {
        const [job] = await claimJobs(1, config.JOB_LEASE_SECONDS);
        if (job) {
          await runJob(job);
        } else {
          await pause(options.pollMs); // nothing to do yet
        }
      } catch (err) {
        // e.g. the database is briefly unreachable: wait and try again, don't crash.
        console.error('worker slot error', err);
        await pause(options.pollMs);
      }
    }
  }

  // Housekeeping: hand back jobs from crashed workers, and delete old finished jobs.
  async function housekeeping() {
    let lastCleanup = 0;
    while (!stopping) {
      try {
        const released = await releaseExpiredJobs();
        if (released > 0) console.log(`released ${released} job(s) from a stopped worker`);
        if (Date.now() - lastCleanup > 60 * 60 * 1000) {
          await deleteOldDoneJobs(24);
          lastCleanup = Date.now();
        }
      } catch (err) {
        console.error('worker housekeeping error', err);
      }
      await pause(Math.min(5000, (config.JOB_LEASE_SECONDS * 1000) / 2));
    }
  }

  const running = [...Array.from({ length: options.concurrency }, () => slot()), housekeeping()];

  return {
    /** Stop taking new jobs, and wait for the ones in progress to finish. */
    async stop() {
      stopping = true;
      stopSignal.abort();
      await Promise.all(running);
    },
  };
}
