import { config } from './config.js';
import { db } from './db.js';
import { startWorker } from './services/worker.js';

// Starts a background worker: `npm run worker`. Run several of these for more throughput.

// Each running job uses a database connection, plus one for looking for work and housekeeping.
if (config.WORKER_CONCURRENCY + 2 > config.DB_POOL_SIZE) {
  throw new Error('WORKER_CONCURRENCY must be at least 2 lower than DB_POOL_SIZE');
}

const worker = startWorker({
  concurrency: config.WORKER_CONCURRENCY,
  pollMs: config.WORKER_POLL_MS,
});
console.log(`worker started: ${config.WORKER_CONCURRENCY} jobs at a time`);

// Clean shutdown (Ctrl-C, or a deploy stopping the process): finish the jobs in progress, take
// no new ones, then close the database connections. A job cut off by a hard kill is picked up
// again by another worker once its claim expires.
async function shutdown() {
  console.log('worker stopping: finishing jobs in progress');
  setTimeout(() => process.exit(1), 30_000).unref(); // don't wait forever
  await worker.stop();
  await db.end();
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
