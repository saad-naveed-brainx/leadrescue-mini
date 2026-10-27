import { setTimeout as sleep } from 'node:timers/promises';
import {
  type MockInstance,
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { db } from '../src/db.js';
import { aiSender } from '../src/services/aiSender.js';
import { withTransaction } from '../src/db.js';
import {
  claimJobs,
  deleteOldDoneJobs,
  enqueueJob,
  finishJob,
  releaseExpiredJobs,
} from '../src/services/queue.js';
import { runWorkerOnce, startWorker } from '../src/services/worker.js';
import { SEED, count, drainJobs, resetDb, sendSms } from './helpers.js';

// The real (mock-provider) send, kept so tests can slow it down and still really send.
const realSend = aiSender.send;
let aiSends: MockInstance<typeof aiSender.send>;

beforeEach(async () => {
  await resetDb();
  aiSends = vi.spyOn(aiSender, 'send');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.end());

/** n different customers text Company A: n messages, n queued jobs. */
async function textsFromNewCustomers(n: number) {
  for (let i = 0; i < n; i++) {
    await sendSms({ fromNumber: `+164655503${String(i).padStart(2, '0')}` });
  }
}

const jobRow = async () =>
  (await db.query('SELECT status, attempts, last_error, run_at > now() AS later FROM jobs'))
    .rows[0];

describe('message and job are saved together', () => {
  it('if the job cannot be saved, the message is not saved either', async () => {
    // Make every job insert fail, for this test only.
    await db.query(`CREATE FUNCTION fail_job_insert() RETURNS trigger LANGUAGE plpgsql AS
                    $$ BEGIN RAISE EXCEPTION 'job insert refused'; END $$`);
    await db.query(`CREATE TRIGGER fail_job_insert BEFORE INSERT ON jobs
                    FOR EACH ROW EXECUTE FUNCTION fail_job_insert()`);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await sendSms({ fromNumber: '+16465550199' });
      expect(res.status).toBe(500);
      expect(await count('messages')).toBe(0);
      expect(await count(`leads WHERE phone = '+16465550199'`)).toBe(0);
    } finally {
      errors.mockRestore();
      await db.query('DROP TRIGGER fail_job_insert ON jobs; DROP FUNCTION fail_job_insert()');
    }
  });
  it('the same job key twice gives one job', async () => {
    const res = await sendSms({ fromNumber: '+16465550199' }); // queues ai_reply:<message id>
    await withTransaction((tx) =>
      enqueueJob(tx, {
        tenantId: SEED.companyA.id,
        conversationId: res.body.conversationId,
        type: 'ai_reply',
        dedupeKey: `ai_reply:${res.body.messageId}`,
      }),
    );
    expect(await count('jobs')).toBe(1);
  });
});

describe('parallel workers', () => {
  it('4 workers claiming at the same moment never get the same job', async () => {
    await textsFromNewCustomers(20);
    const claims = await Promise.all([1, 2, 3, 4].map(() => claimJobs(10, 60)));
    const ids = claims.flat().map((j) => j.id);
    expect(ids).toHaveLength(20); // every job taken once
    expect(new Set(ids).size).toBe(20); // and no job twice
  });

  it("a worker never waits for another worker's jobs: it skips them and takes the next ones", async () => {
    await textsFromNewCustomers(4);
    // Worker 1 is in the middle of claiming: it holds 2 jobs locked and hasn't finished yet.
    const worker1 = await db.connect();
    try {
      await worker1.query('BEGIN');
      await worker1.query(
        `SELECT id FROM jobs WHERE status = 'pending' ORDER BY run_at LIMIT 2 FOR UPDATE`,
      );

      // Worker 2 must get the other 2 jobs straight away, not wait for worker 1.
      const startedAt = Date.now();
      const claimed = await Promise.race([
        claimJobs(10, 60),
        sleep(1000).then(() => 'waited' as const),
      ]);
      expect(claimed).not.toBe('waited');
      expect(claimed).toHaveLength(2);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      await worker1.query('ROLLBACK');
      worker1.release();
    }
  });

  it('one worker process runs several jobs at the same time', async () => {
    await textsFromNewCustomers(10);
    aiSends.mockImplementation(async (sms) => {
      await sleep(200); // a slow SMS provider
      return realSend(sms);
    });

    const startedAt = Date.now();
    const worker = startWorker({ concurrency: 5, pollMs: 20 });
    while ((await count(`jobs WHERE status = 'done'`)) < 10) await sleep(20);
    await worker.stop();

    // One at a time would take 10 × 200 ms = 2 s; 5 at a time takes about 0.4 s.
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(aiSends).toHaveBeenCalledTimes(10);
  });

  it('stopping a worker lets the job in progress finish', async () => {
    aiSends.mockImplementation(async (sms) => {
      await sleep(300);
      return realSend(sms);
    });
    const worker = startWorker({ concurrency: 1, pollMs: 20 });
    await sendSms({ fromNumber: '+16465550199' });
    while ((await count(`jobs WHERE status = 'running'`)) === 0) await sleep(10);

    await worker.stop();
    expect(await jobRow()).toMatchObject({ status: 'done' });
    expect(aiSends).toHaveBeenCalledTimes(1);
  });
});

describe('failures and retries', () => {
  it('a failed send is retried later; the saved "sending" reply is then sent once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    aiSends.mockRejectedValueOnce(new Error('AI service down'));
    await sendSms({ fromNumber: '+16465550199' });

    await runWorkerOnce();
    expect(await jobRow()).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'AI service down',
      later: true, // waits before the next try
    });
    // The reply was saved as 'sending' before the provider call, and stays so until it goes out.
    expect(await count(`messages WHERE author = 'ai' AND send_status = 'sending'`)).toBe(1);
    expect(await count('mock_sms_sent')).toBe(0); // the provider never got it

    await db.query('UPDATE jobs SET run_at = now()'); // skip the wait
    await drainJobs();
    expect(await jobRow()).toMatchObject({ status: 'done', attempts: 2 });
    expect(await count(`messages WHERE author = 'ai' AND send_status = 'sent'`)).toBe(1);
    expect(await count('mock_sms_sent')).toBe(1);
  });

  it('after max attempts the job is marked failed and not retried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    aiSends.mockRejectedValue(new Error('AI service down'));
    await sendSms({ fromNumber: '+16465550199' });
    await db.query('UPDATE jobs SET max_attempts = 3');

    for (let i = 0; i < 3; i++) {
      await runWorkerOnce();
      await db.query('UPDATE jobs SET run_at = now()');
    }
    expect(await jobRow()).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await runWorkerOnce()).toBe(0);
  });

  it("a crashed worker's job goes back to the queue and another worker finishes it", async () => {
    await sendSms({ fromNumber: '+16465550199' });
    await claimJobs(1, 60); // a worker takes it ... and crashes (never finishes)
    await db.query(`UPDATE jobs SET locked_until = now() - interval '1 second'`); // claim expires

    expect(await releaseExpiredJobs()).toBe(1);
    await drainJobs();
    expect(await jobRow()).toMatchObject({ status: 'done' });
    expect(aiSends).toHaveBeenCalledTimes(1);
  });

  it('a worker whose claim expired cannot mark the job done any more', async () => {
    await sendSms({ fromNumber: '+16465550199' });
    const [slowWorkersJob] = await claimJobs(1, 60);
    await db.query(`UPDATE jobs SET locked_until = now() - interval '1 second'`);
    await releaseExpiredJobs();
    await claimJobs(1, 60); // another worker takes it over (attempt 2)

    expect(await finishJob(slowWorkersJob!)).toBe(false);
    expect(await jobRow()).toMatchObject({ status: 'running', attempts: 2 });
  });
});

describe('housekeeping', () => {
  it('old finished jobs are deleted, recent ones kept', async () => {
    await textsFromNewCustomers(2);
    await drainJobs();
    await db.query(
      `UPDATE jobs SET updated_at = now() - interval '2 days'
        WHERE id = (SELECT id FROM jobs ORDER BY created_at LIMIT 1)`,
    );
    expect(await deleteOldDoneJobs(24)).toBe(1);
    expect(await count('jobs')).toBe(1);
  });
});
