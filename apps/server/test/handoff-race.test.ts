import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db.js';
import { mockSms } from '../src/services/mockSms.js';
import { testApp } from './helpers/app.js';
import { bearer } from './helpers/auth.js';
import { SEED, resetDb } from './helpers/db.js';
import { customerTexts } from './helpers/twilio.js';
import { drainQueue, providerSends } from './helpers/worker.js';

const { app } = testApp();
afterAll(() => db.end());
beforeEach(() => resetDb(db));
afterEach(() => vi.restoreAllMocks());

const ACME_NUMBER = SEED.phoneNumbers.acme.e164;
const CUSTOMER = '+16465550190';

async function switchMode(
  conversationId: string,
  mode: 'auto' | 'manual',
  user: 'alice' | 'aaron' | 'bella' = 'alice',
) {
  return request(app)
    .patch(`/conversations/${conversationId}/mode`)
    .set('Authorization', await bearer(user))
    .send({ mode });
}

/** Automatic texts the provider sent after staff took the conversation over. Must always be 0. */
async function sendsAfterHandoff(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM mock_provider_messages p
       JOIN messages m ON m.idempotency_key = p.client_ref
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.mode = 'manual' AND p.created_at > c.mode_changed_at`,
  );
  return rows[0]!.n;
}

describe('staff take over a conversation (SOW demo 4)', () => {
  it('before the worker gets to the reply: nothing is sent', async () => {
    const conversationId = await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');
    const res = await switchMode(conversationId, 'manual');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: conversationId, mode: 'manual' });
    // The waiting reply is called off at once, not just stopped later by the send gate.
    const job = await db.query(`SELECT status, cancel_reason FROM workflow_jobs`);
    expect(job.rows).toEqual([{ status: 'cancelled', cancel_reason: 'manual_mode' }]);
    await drainQueue();
    expect(await providerSends()).toHaveLength(0);
  });

  it('while a reply is being sent: the switch waits for it, and the history shows the text first', async () => {
    const conversationId = await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');

    // Hold the pretend SMS service mid-send, so the worker sits inside the send gate.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reachedSend!: () => void;
    const atSend = new Promise<void>((r) => (reachedSend = r));
    const realSend = mockSms.send;
    vi.spyOn(mockSms, 'send').mockImplementation(async (sms) => {
      reachedSend();
      await held;
      return realSend(sms);
    });

    const worker = drainQueue();
    await atSend;
    const handoff = Promise.resolve(switchMode(conversationId, 'manual'));
    const early = await Promise.race([
      handoff.then(() => 'finished'),
      sleep(300).then(() => 'waiting'),
    ]);
    expect(early).toBe('waiting'); // the switch is waiting for the conversation lock

    release();
    expect((await handoff).status).toBe(200);
    await worker;

    expect(await providerSends()).toHaveLength(1); // the reply that was already on its way
    expect(await sendsAfterHandoff()).toBe(0); // and it went out before the switch
  });

  it('STOP arriving while a reply is being sent: both finish (no deadlock), and STOP wins afterwards', async () => {
    await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reachedSend!: () => void;
    const atSend = new Promise<void>((r) => (reachedSend = r));
    const realSend = mockSms.send;
    vi.spyOn(mockSms, 'send').mockImplementation(async (sms) => {
      reachedSend();
      await held;
      return realSend(sms);
    });

    const worker = drainQueue();
    await atSend;
    const stop = Promise.resolve(customerTexts(app, CUSTOMER, ACME_NUMBER, 'STOP'));
    await sleep(200); // let STOP reach the lock and wait there
    release();
    await stop;
    await worker;

    const jobs = await db.query(
      `SELECT type, status, cancel_reason FROM workflow_jobs ORDER BY created_at`,
    );
    expect(jobs.rows).toEqual([
      { type: 'ai_reply', status: 'succeeded', cancel_reason: null }, // was already on its way
      { type: 'follow_up', status: 'cancelled', cancel_reason: 'opted_out' }, // STOP called it off
    ]);
    expect(await providerSends()).toHaveLength(1);
  });

  it('closing the lead while a reply is being sent: it waits, then calls off the follow-up that reply planned', async () => {
    await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');
    const lead = await db.query<{ id: string }>('SELECT id FROM leads WHERE phone_e164 = $1', [
      CUSTOMER,
    ]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reachedSend!: () => void;
    const atSend = new Promise<void>((r) => (reachedSend = r));
    const realSend = mockSms.send;
    vi.spyOn(mockSms, 'send').mockImplementation(async (sms) => {
      reachedSend();
      await held;
      return realSend(sms);
    });

    const worker = drainQueue();
    await atSend;
    const close = Promise.resolve(
      request(app)
        .patch(`/leads/${lead.rows[0]!.id}`)
        .set('Authorization', await bearer('alice'))
        .send({ status: 'closed' }),
    );
    const early = await Promise.race([
      close.then(() => 'finished'),
      sleep(300).then(() => 'waiting'),
    ]);
    expect(early).toBe('waiting');
    release();
    expect((await close).status).toBe(200);
    await worker;

    const followUp = await db.query(
      `SELECT status, cancel_reason FROM workflow_jobs WHERE type = 'follow_up'`,
    );
    expect(followUp.rows).toEqual([{ status: 'cancelled', cancel_reason: 'lead_closed' }]);
  });

  it('50 rounds of the worker and staff racing in random order: never a text after the switch', async () => {
    for (let i = 0; i < 50; i++) {
      const customer = `+1646555${String(140 + i).padStart(4, '0')}`;
      const conversationId = await customerTexts(app, customer, ACME_NUMBER, 'Hi');
      await Promise.all([
        sleep(Math.random() * 15).then(() => drainQueue()),
        sleep(Math.random() * 15).then(() => switchMode(conversationId, 'manual')),
      ]);
    }
    expect(await sendsAfterHandoff()).toBe(0);
    // Every reply either went out before the switch or was called off; none left hanging.
    const leftover = await db.query(
      `SELECT 1 FROM workflow_jobs WHERE type = 'ai_reply' AND status NOT IN ('succeeded', 'cancelled')`,
    );
    expect(leftover.rowCount).toBe(0);
  });
});

describe('the Auto/Manual switch', () => {
  it('records who switched, from what to what, and only when something changed', async () => {
    const conversationId = await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');
    await switchMode(conversationId, 'manual');
    await switchMode(conversationId, 'manual'); // already manual: nothing to record
    const { rows } = await db.query(
      `SELECT actor_user_id, metadata FROM audit_events WHERE action = 'conversation.mode_changed'`,
    );
    expect(rows).toEqual([
      { actor_user_id: SEED.users.alice.id, metadata: { from: 'auto', to: 'manual' } },
    ]);
  });

  it('switching back to Auto lets the AI answer new texts again', async () => {
    const conversationId = await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');
    await switchMode(conversationId, 'manual');
    await drainQueue();
    await switchMode(conversationId, 'auto');
    await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Anyone there?');
    await drainQueue();
    expect(await providerSends()).toHaveLength(1);
  });

  it('a member can switch; another business gets "not found" and changes nothing', async () => {
    const conversationId = await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');
    expect((await switchMode(conversationId, 'manual', 'bella')).status).toBe(404);
    const mode = await db.query('SELECT mode FROM conversations WHERE id = $1', [conversationId]);
    expect(mode.rows[0]).toEqual({ mode: 'auto' });
    expect((await switchMode(conversationId, 'manual', 'aaron')).status).toBe(200);
  });

  it('rejects a malformed id, an unknown mode and extra fields', async () => {
    const conversationId = await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');
    const auth = await bearer('alice');
    const patch = (id: string, body: object) =>
      request(app).patch(`/conversations/${id}/mode`).set('Authorization', auth).send(body);
    expect((await patch('not-a-uuid', { mode: 'manual' })).status).toBe(404);
    expect((await patch(conversationId, { mode: 'off' })).status).toBe(400);
    expect(
      (await patch(conversationId, { mode: 'manual', orgId: SEED.orgs.bright.id })).status,
    ).toBe(400);
  });

  it('requires sign-in', async () => {
    const conversationId = await customerTexts(app, CUSTOMER, ACME_NUMBER, 'Hi');
    const res = await request(app)
      .patch(`/conversations/${conversationId}/mode`)
      .send({ mode: 'manual' });
    expect(res.status).toBe(401);
  });
});
