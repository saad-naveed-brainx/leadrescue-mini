import { config } from '../config.js';

// Test-only switches for the crash tests (test/worker-restart.test.ts). They do nothing unless
// NODE_ENV=test, so they can never be switched on in a real deployment.
const testing = config.NODE_ENV === 'test';

export type CrashPoint = 'after_claim' | 'after_intent' | 'after_provider_send';

/** If WORKER_CRASH_AT names this point, quit on the spot, like a power cut: no clean-up at all. */
export function crashHere(point: CrashPoint): void {
  if (testing && process.env.WORKER_CRASH_AT === point) process.exit(99);
}

/** Makes the pretend SMS service slow (MOCK_SMS_DELAY_MS), so a test can kill the worker mid-batch. */
export function mockSmsDelayMs(): number {
  return testing ? Number(process.env.MOCK_SMS_DELAY_MS ?? 0) : 0;
}
