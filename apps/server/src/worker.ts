import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { db } from './db.js';
import { logger } from './logger.js';
import { runWorkerOnce } from './services/worker.js';

// The background worker: `npm run dev:worker`. It runs next to the API as a separate program and
// keeps doing queued jobs (sending AI replies, and from M5 follow-ups).

const WORKER_ID = `worker-${hostname()}-${process.pid}`;
let stopping = false;

// Ctrl-C or Docker stopping it: finish the jobs it has already taken, then stop. A job cut off by a
// hard kill is rescued by the next worker once its lease runs out (WORKER_LEASE_SECONDS).
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

logger.info({ workerId: WORKER_ID }, 'worker started');

while (!stopping) {
  try {
    const ran = await runWorkerOnce(WORKER_ID);
    if (ran === 0) await sleep(1000); // nothing to do: check again in a second
  } catch (err) {
    // For example, the database is briefly unreachable. Wait, then try again.
    logger.error({ err }, 'worker round failed');
    await sleep(1000);
  }
}

await db.end();
logger.info('worker stopped');
