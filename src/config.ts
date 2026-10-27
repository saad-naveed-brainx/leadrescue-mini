import { fileURLToPath } from 'node:url';

// All settings come from environment variables. Locally they are read from the .env file in the
// project root. The tests set them in vitest.config.ts, so .env is skipped there.
if (process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch {
    // No .env file: use the environment as it is.
  }
}

/** A whole-number setting above 0, or its default. Stops startup with a clear message if wrong. */
function positiveNumber(name: string, defaultValue: number): number {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a whole number above 0`);
  }
  return value;
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL. Copy .env.example to .env.');

export const config = {
  DATABASE_URL,
  PORT: positiveNumber('PORT', 4000),
  // Database connections each process may open (API and each worker have their own).
  DB_POOL_SIZE: positiveNumber('DB_POOL_SIZE', 10),
  // Jobs one worker process runs at the same time. Run more worker processes for more.
  WORKER_CONCURRENCY: positiveNumber('WORKER_CONCURRENCY', 5),
  // How often an idle worker looks for new jobs.
  WORKER_POLL_MS: positiveNumber('WORKER_POLL_MS', 500),
  // How long a worker may hold a job before others assume it crashed and take it over.
  JOB_LEASE_SECONDS: positiveNumber('JOB_LEASE_SECONDS', 60),
};
