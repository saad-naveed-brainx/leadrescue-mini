import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { testApp } from './helpers/app.js';
import { SEED, resetDb } from './helpers/db.js';
import { customerTexts } from './helpers/twilio.js';
import { providerSends } from './helpers/worker.js';

// These tests start the REAL worker program (src/worker.ts) as a separate process, make it crash
// at the worst moments, start it again, and check what the customer actually received (SOW demo 6).

const { app } = testApp();
afterAll(() => db.end());
beforeEach(() => resetDb(db));

const ACME_NUMBER = SEED.phoneNumbers.acme.e164;
const running: ChildProcess[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

/** Starts the worker program. A short lease (2 s) so a crashed worker's jobs are rescued quickly. */
function startWorker(extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    env: { ...process.env, WORKER_LEASE_SECONDS: '2', ...extraEnv },
    stdio: 'ignore',
  });
  running.push(child);
  const exitCode = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => resolve(code)),
  );
  return { child, exitCode };
}

/** Checks `condition` every 100 ms until it's true, or fails after `timeoutMs`. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(100);
  }
}

async function replyJobs() {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM workflow_jobs WHERE type = 'ai_reply' ORDER BY created_at`,
  );
  return rows.map((r) => r.status);
}

const allRepliesDone = async () => (await replyJobs()).every((s) => s === 'succeeded');

describe('the worker crashes at the worst moments, then restarts (SOW demo 6)', () => {
  it.each([
    ['after_claim', 'it took the job but did nothing yet', 0],
    ['after_intent', 'it wrote "about to send" but never sent', 0],
    ['after_provider_send', 'the text went out, but "sent" was never written down', 1],
  ] as const)(
    'crash %s (%s): after a restart the customer has exactly one text',
    async (point, _meaning, sendsAtCrash) => {
      await customerTexts(app, '+16465550190', ACME_NUMBER, 'Hi');

      const crashing = startWorker({ WORKER_CRASH_AT: point });
      expect(await crashing.exitCode).toBe(99); // it really crashed at that point
      expect(await providerSends()).toHaveLength(sendsAtCrash);
      expect(await replyJobs()).toEqual(['running']); // stuck with the dead worker's name on it

      const worker = startWorker();
      await waitFor(allRepliesDone);
      worker.child.kill('SIGTERM');
      expect(await worker.exitCode).toBe(0);

      expect(await providerSends()).toHaveLength(1);
      const reply = await db.query(`SELECT status FROM messages WHERE direction = 'outbound'`);
      expect(reply.rows).toEqual([{ status: 'sent' }]);
    },
    40_000,
  );

  it('killed in the middle of a batch of 10: after a restart all 10 get exactly one reply', async () => {
    for (let i = 0; i < 10; i++) {
      await customerTexts(app, `+1646555${String(150 + i).padStart(4, '0')}`, ACME_NUMBER, 'Hi');
    }
    // Slow sends down so there's time to pull the plug halfway.
    const first = startWorker({ MOCK_SMS_DELAY_MS: '150' });
    await waitFor(async () => (await providerSends()).length >= 2);
    first.child.kill('SIGKILL');
    await first.exitCode;
    expect((await providerSends()).length).toBeLessThan(10); // really stopped partway

    const second = startWorker();
    await waitFor(allRepliesDone);
    second.child.kill('SIGTERM');
    await second.exitCode;

    const sends = await providerSends();
    expect(sends).toHaveLength(10);
    expect(new Set(sends.map((s) => s.client_ref)).size).toBe(10); // one each, none twice
  }, 60_000);
});

describe('a normal stop (Ctrl-C, or Docker stopping it)', () => {
  it('finishes the jobs it already took, then exits cleanly', async () => {
    for (let i = 0; i < 3; i++) {
      await customerTexts(app, `+1646555${String(170 + i).padStart(4, '0')}`, ACME_NUMBER, 'Hi');
    }
    const worker = startWorker({ MOCK_SMS_DELAY_MS: '300' });
    await waitFor(async () => (await providerSends()).length >= 1);
    worker.child.kill('SIGTERM');
    expect(await worker.exitCode).toBe(0);

    expect(await replyJobs()).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(await providerSends()).toHaveLength(3);
  }, 30_000);
});
