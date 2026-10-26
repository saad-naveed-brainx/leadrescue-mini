import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import {
  PermanentJobError,
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  listDeadJobs,
  reapExpiredJobs,
  retryDeadJob,
} from '../src/services/jobs.js';
import { SEED, createConversation, leadIdByName, resetDb } from './helpers/db.js';

afterAll(() => db.end());

const ACME = SEED.orgs.acme.id;
let conversationId: string;

beforeEach(async () => {
  await resetDb(db);
  const leadId = await leadIdByName(db, 'Maria Lopez');
  conversationId = await createConversation(db, ACME, leadId, SEED.phoneNumbers.acme.id);
});

async function addJobs(n: number) {
  for (let i = 0; i < n; i++) {
    await enqueueJob(db, {
      orgId: ACME,
      conversationId,
      type: 'ai_reply',
      payload: { inboundMessageId: `test-${i}` },
      dedupeKey: `test-job-${i}`,
    });
  }
}

async function jobRow(id: string) {
  const { rows } = await db.query(
    `SELECT status, attempts, locked_by, last_error, run_at > now() AS "later"
       FROM workflow_jobs WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe('taking jobs', () => {
  it('two workers asking at the same moment each get their own jobs, without waiting', async () => {
    await addJobs(10);
    const [a, b] = await Promise.all([claimJobs('worker-a', 5, 60), claimJobs('worker-b', 5, 60)]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(10); // no job handed out twice
  });

  it('a worker does not wait for jobs another worker is in the middle of taking', async () => {
    await addJobs(10);
    // Worker A is halfway through taking 5 jobs: it holds their row locks and hasn't finished.
    const workerA = await db.connect();
    await workerA.query('BEGIN');
    await workerA.query(`SELECT id FROM workflow_jobs ORDER BY run_at LIMIT 5 FOR UPDATE`);
    try {
      // Worker B should skip those 5 and take the other 5 straight away.
      const timeout = new Promise<'waited'>((r) => setTimeout(() => r('waited'), 2000));
      const claimB = claimJobs('worker-b', 5, 60);
      const b = await Promise.race([claimB, timeout]);
      await workerA.query('ROLLBACK');
      await claimB; // let it finish either way before the next test
      expect(b).not.toBe('waited');
      expect(b).toHaveLength(5);
    } finally {
      workerA.release();
    }
  });

  it('a job planned for later is not taken yet', async () => {
    await enqueueJob(db, {
      orgId: ACME,
      conversationId,
      type: 'follow_up',
      payload: {},
      dedupeKey: 'later',
      runAt: new Date(Date.now() + 60_000),
    });
    expect(await claimJobs('worker-a', 10, 60)).toHaveLength(0);
  });
});

describe('finishing jobs', () => {
  it('a worker whose job was taken over cannot mark it finished (fencing)', async () => {
    await addJobs(1);
    const [job] = await claimJobs('worker-a', 1, 60);
    expect(await completeJob(job!, 'worker-b')).toBe(false);
    expect((await jobRow(job!.id))!.status).toBe('running');
    expect(await completeJob(job!, 'worker-a')).toBe(true);
    expect((await jobRow(job!.id))!.status).toBe('succeeded');
  });

  it('a failed job waits and is tried again later', async () => {
    await addJobs(1);
    const [job] = await claimJobs('worker-a', 1, 60);
    await failJob(job!, 'worker-a', new Error('AI timed out'));
    expect(await jobRow(job!.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      locked_by: null,
      last_error: 'AI timed out',
      later: true,
    });
  });

  it('after its last attempt a job is marked dead and recorded in the audit history', async () => {
    await addJobs(1);
    await db.query('UPDATE workflow_jobs SET max_attempts = 1');
    const [job] = await claimJobs('worker-a', 1, 60);
    await failJob(job!, 'worker-a', new Error('still failing'));
    expect((await jobRow(job!.id))!.status).toBe('dead');
    const audit = await db.query(`SELECT 1 FROM audit_events WHERE action = 'job.dead'`);
    expect(audit.rowCount).toBe(1);
  });

  it('a permanent error goes straight to dead, without retries', async () => {
    await addJobs(1);
    const [job] = await claimJobs('worker-a', 1, 60);
    await failJob(job!, 'worker-a', new PermanentJobError('bad payload'));
    expect((await jobRow(job!.id))!.status).toBe('dead');
  });
});

describe('rescuing jobs from a crashed worker', () => {
  it('a job whose lease ran out goes back to waiting', async () => {
    await addJobs(1);
    const [job] = await claimJobs('crashed-worker', 1, 60);
    await db.query(`UPDATE workflow_jobs SET locked_until = now() - interval '1 second'`);
    expect(await reapExpiredJobs()).toBe(1);
    expect(await jobRow(job!.id)).toMatchObject({ status: 'pending', locked_by: null });
    // ...and another worker can take it.
    expect(await claimJobs('worker-b', 1, 60)).toHaveLength(1);
  });

  it('a job still inside its lease is left alone', async () => {
    await addJobs(1);
    await claimJobs('busy-worker', 1, 60);
    expect(await reapExpiredJobs()).toBe(0);
  });

  it('a job that crashed the worker on its last attempt is marked dead instead of looping', async () => {
    await addJobs(1);
    await db.query('UPDATE workflow_jobs SET max_attempts = 1');
    const [job] = await claimJobs('crashed-worker', 1, 60);
    await db.query(`UPDATE workflow_jobs SET locked_until = now() - interval '1 second'`);
    await reapExpiredJobs();
    expect((await jobRow(job!.id))!.status).toBe('dead');
  });
});

describe('the dead-job tool (npm run jobs)', () => {
  async function makeDeadJob() {
    await addJobs(1);
    await db.query('UPDATE workflow_jobs SET max_attempts = 1');
    const [job] = await claimJobs('worker-a', 1, 60);
    await failJob(job!, 'worker-a', new Error('AI down'));
    return job!.id;
  }

  it('lists dead jobs with why they failed', async () => {
    const id = await makeDeadJob();
    expect(await listDeadJobs()).toMatchObject([{ id, type: 'ai_reply', lastError: 'AI down' }]);
  });

  it('retry puts a dead job back in the queue with fresh attempts, and records who asked', async () => {
    const id = await makeDeadJob();
    expect(await retryDeadJob(id, 'saad')).toBe(true);
    expect(await jobRow(id)).toMatchObject({ status: 'pending', attempts: 0, later: false });
    const audit = await db.query(
      `SELECT metadata->>'requestedBy' AS by FROM audit_events WHERE action = 'job.retried'`,
    );
    expect(audit.rows).toEqual([{ by: 'saad' }]);
  });

  it('refuses to "retry" a job that is not dead', async () => {
    await addJobs(1);
    const { rows } = await db.query<{ id: string }>('SELECT id FROM workflow_jobs');
    expect(await retryDeadJob(rows[0]!.id, 'saad')).toBe(false);
    expect(await jobRow(rows[0]!.id)).toMatchObject({ status: 'pending' });
  });
});
