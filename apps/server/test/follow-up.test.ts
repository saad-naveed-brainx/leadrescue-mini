import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { claimJobs } from '../src/services/jobs.js';
import { runJob } from '../src/services/worker.js';
import { testApp } from './helpers/app.js';
import { bearer } from './helpers/auth.js';
import { SEED, resetDb } from './helpers/db.js';
import { customerTexts } from './helpers/twilio.js';
import { drainQueue, providerSends } from './helpers/worker.js';

const { app } = testApp();
afterAll(() => db.end());
beforeEach(() => resetDb(db));

const ACME_NUMBER = SEED.phoneNumbers.acme.e164;
const CUSTOMER = '+16465550190';

const texts = (body: string) => customerTexts(app, CUSTOMER, ACME_NUMBER, body);

/** The follow-up jobs, oldest first. vitest.config.ts sets the delay to 60 seconds. */
async function followUps() {
  const { rows } = await db.query<{
    status: string;
    cancel_reason: string | null;
    inAboutAMinute: boolean;
  }>(
    `SELECT status, cancel_reason,
            run_at BETWEEN now() + interval '50 seconds' AND now() + interval '70 seconds' AS "inAboutAMinute"
       FROM workflow_jobs WHERE type = 'follow_up' ORDER BY created_at`,
  );
  return rows;
}

/** Pretend the waiting time has passed. */
const fastForward = () =>
  db.query(`UPDATE workflow_jobs SET run_at = now() WHERE status = 'pending'`);

async function switchMode(conversationId: string, mode: 'auto' | 'manual') {
  return request(app)
    .patch(`/conversations/${conversationId}/mode`)
    .set('Authorization', await bearer('alice'))
    .send({ mode });
}

describe('the one "just checking in" text', () => {
  it('an AI reply plans one follow-up, after the configured delay', async () => {
    await texts('Hi');
    await drainQueue();
    expect(await followUps()).toEqual([
      { status: 'pending', cancel_reason: null, inAboutAMinute: true },
    ]);
  });

  it('if the customer stays quiet, exactly one check-in goes out, and never a second', async () => {
    await texts('Hi');
    await drainQueue();
    await fastForward();
    await drainQueue();

    const sends = await providerSends();
    expect(sends).toHaveLength(2); // the AI reply, then the check-in
    expect(sends[1]!.body).toContain('just checking in from Acme Plumbing');
    expect(await followUps()).toEqual([
      { status: 'succeeded', cancel_reason: null, inAboutAMinute: false },
    ]);

    // No follow-up after the follow-up.
    await fastForward();
    await drainQueue();
    expect(await providerSends()).toHaveLength(2);
  });
});

describe('the follow-up is called off when', () => {
  it('the customer replies (and the new AI reply plans its own)', async () => {
    await texts('Hi');
    await drainQueue();
    await texts('Tuesday works for me');
    await drainQueue();
    expect((await followUps()).map((f) => [f.status, f.cancel_reason])).toEqual([
      ['cancelled', 'lead_replied'],
      ['pending', null],
    ]);
  });

  it('the customer says STOP', async () => {
    await texts('Hi');
    await drainQueue();
    await texts('STOP');
    await fastForward();
    await drainQueue();
    expect((await followUps())[0]).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'opted_out',
    });
    expect(await providerSends()).toHaveLength(1);
  });

  it('staff take over the conversation', async () => {
    const conversationId = await texts('Hi');
    await drainQueue();
    expect((await switchMode(conversationId, 'manual')).status).toBe(200);
    await fastForward();
    await drainQueue();
    expect((await followUps())[0]).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'manual_mode',
    });
    expect(await providerSends()).toHaveLength(1);
  });

  it('staff close the lead', async () => {
    await texts('Hi');
    await drainQueue();
    const lead = await db.query<{ id: string }>('SELECT id FROM leads WHERE phone_e164 = $1', [
      CUSTOMER,
    ]);
    const res = await request(app)
      .patch(`/leads/${lead.rows[0]!.id}`)
      .set('Authorization', await bearer('alice'))
      .send({ status: 'closed' });
    expect(res.status).toBe(200);
    expect((await followUps())[0]).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'lead_closed',
    });
    await fastForward();
    await drainQueue();
    expect((await followUps())[0]).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'lead_closed',
    });
    expect(await providerSends()).toHaveLength(1);
  });

  it('the customer replies while the follow-up job is already running', async () => {
    await texts('Hi');
    await drainQueue();
    await fastForward();
    const [job] = await claimJobs('slow-worker', 1, 60);
    // The customer answers, but the worker already holds the follow-up, so only the follow-up's
    // own check can stop it. (The new text's reply job just waits; we only run the follow-up.)
    await texts('Yes, still interested');
    await runJob(job!, 'slow-worker');
    expect((await followUps())[0]).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'lead_replied',
    });
    expect(await providerSends()).toHaveLength(1);
  });

  it('staff take over while the follow-up job is already running (checked again before sending)', async () => {
    const conversationId = await texts('Hi');
    await drainQueue();
    await fastForward();
    const [job] = await claimJobs('slow-worker', 1, 60); // the worker has picked it up...
    await switchMode(conversationId, 'manual'); // ...staff take over (only waiting jobs get cancelled)...
    await runJob(job!, 'slow-worker'); // ...and the worker carries on
    expect((await followUps())[0]).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'manual_mode',
    });
    expect(await providerSends()).toHaveLength(1);
  });
});
