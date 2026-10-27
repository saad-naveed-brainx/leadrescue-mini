import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { db } from '../src/db.js';
import { SEED, seed } from '../src/scripts/seed.js';
import { runWorkerOnce } from '../src/services/worker.js';

export { SEED };

// The two seeded users, as the X-Demo-User header value.
export const ALICE_A = SEED.companyA.user.email;
export const BOB_B = SEED.companyB.user.email;

/** Empties every table and puts the standard seed back (2 companies, 2 users, 3 leads). */
export async function resetDb(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'TRUNCATE mock_sms_sent, jobs, messages, conversations, leads, users, tenants CASCADE',
    );
    await seed(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** An API call made as a seeded user. */
export const as = (user: string) => ({
  get: (url: string) => request(app).get(url).set('X-Demo-User', user),
  post: (url: string, body: object) => request(app).post(url).set('X-Demo-User', user).send(body),
  patch: (url: string, body: object) => request(app).patch(url).set('X-Demo-User', user).send(body),
});

export interface Sms {
  messageSid?: string;
  toNumber?: string;
  fromNumber?: string;
  body?: string;
}

/** Posts a simulated Twilio inbound SMS. Defaults: a customer texting Company A, a new messageSid. */
export function sendSms(sms: Sms = {}) {
  return request(app)
    .post('/webhooks/twilio/inbound')
    .send({
      messageSid: sms.messageSid ?? `SM${randomUUID().replaceAll('-', '')}`,
      toNumber: sms.toNumber ?? SEED.companyA.phoneNumber,
      fromNumber: sms.fromNumber ?? '+16465550199',
      body: sms.body ?? 'Hi, do you do weekend callouts?',
    });
}

/** Runs the background worker until no job is due, as `npm run worker` would. */
export async function drainJobs(): Promise<void> {
  for (let round = 0; round < 20; round++) {
    if ((await runWorkerOnce(50)) === 0) return;
  }
  throw new Error('jobs still due after 20 rounds');
}

/** How many rows a query counts. */
export async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params);
  return rows[0]!.n;
}
