import { db } from '../../src/db.js';
import { runWorkerOnce } from '../../src/services/worker.js';

export const TEST_WORKER = 'test-worker';

/** Runs the worker until no due job is left (like letting the real worker run for a while). */
export async function drainQueue(workerId = TEST_WORKER): Promise<void> {
  for (let round = 0; round < 50; round++) {
    if ((await runWorkerOnce(workerId)) === 0) return;
  }
  throw new Error('queue did not drain in 50 rounds');
}

/** Every row the pretend SMS service "sent", oldest first. */
export async function providerSends() {
  const { rows } = await db.query<{ client_ref: string; to_e164: string; body: string }>(
    'SELECT client_ref, to_e164, body FROM mock_provider_messages ORDER BY created_at',
  );
  return rows;
}
