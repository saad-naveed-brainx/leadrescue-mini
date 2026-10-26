import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';
import { bearer } from './helpers/auth.js';
import { SEED, resetDb } from './helpers/db.js';
import { newSid, postInbound } from './helpers/twilio.js';

const { pool, app } = testApp();
afterAll(() => pool.end());
beforeEach(() => resetDb(pool));

const ACME_NUMBER = SEED.phoneNumbers.acme.e164;
const BRIGHT_NUMBER = SEED.phoneNumbers.bright.e164;
const STRANGER = '+16465550190';

// Only these names can be interpolated into the query below.
type Table =
  | 'webhook_receipts'
  | 'leads'
  | 'conversations'
  | 'messages'
  | 'workflow_jobs'
  | 'opt_outs'
  | 'audit_events';

/** Row count; `where` must be a fixed SQL string, with values passed as `params`. */
async function count(table: Table, where = 'true', params: unknown[] = []) {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(rows[0]!.n);
}

/** Everything one inbound SMS can create, for before/after comparisons. */
async function snapshot() {
  return {
    receipts: await count('webhook_receipts'),
    leads: await count('leads'),
    conversations: await count('conversations'),
    messages: await count('messages'),
    jobs: await count('workflow_jobs'),
    optOuts: await count('opt_outs'),
  };
}

describe('signature check', () => {
  it('refuses unsigned and wrongly signed requests and stores nothing', async () => {
    const before = await snapshot();
    const unsigned = await postInbound(
      app,
      { From: STRANGER, To: ACME_NUMBER, Body: 'hi' },
      { signature: null },
    );
    const forged = await postInbound(
      app,
      { From: STRANGER, To: ACME_NUMBER, Body: 'hi' },
      { signature: 'bm90LWEtcmVhbC1zaWduYXR1cmU=' },
    );
    expect(unsigned.status).toBe(403);
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await snapshot()).toEqual(before);
  });
});

describe('a normal inbound SMS', () => {
  it('creates a lead, conversation and message, queues one AI reply, and answers with empty TwiML', async () => {
    const sid = newSid();
    const res = await postInbound(app, {
      From: STRANGER,
      To: ACME_NUMBER,
      Body: 'Leaking sink',
      MessageSid: sid,
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<Response></Response>');

    const lead = (await pool.query('SELECT * FROM leads WHERE phone_e164 = $1', [STRANGER]))
      .rows[0];
    expect(lead).toMatchObject({
      org_id: SEED.orgs.acme.id,
      source: 'sms',
      status: 'new',
      name: null,
    });

    const conv = (await pool.query('SELECT * FROM conversations WHERE lead_id = $1', [lead.id]))
      .rows[0];
    expect(conv).toMatchObject({
      org_id: SEED.orgs.acme.id,
      mode: 'auto',
      phone_number_id: SEED.phoneNumbers.acme.id,
    });

    const msg = (await pool.query('SELECT * FROM messages WHERE conversation_id = $1', [conv.id]))
      .rows[0];
    expect(msg).toMatchObject({
      direction: 'inbound',
      author: 'lead',
      body: 'Leaking sink',
      provider_message_id: sid,
    });

    const jobs = (
      await pool.query('SELECT * FROM workflow_jobs WHERE conversation_id = $1', [conv.id])
    ).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'ai_reply',
      status: 'pending',
      dedupe_key: `ai_reply:${msg.id}`,
      payload: { inboundMessageId: msg.id },
    });
    // The webhook's request id travels with the job, so the worker's logs can be tied back to it.
    expect(jobs[0].correlation_id).toBe(res.headers['x-request-id']);

    const receipt = (
      await pool.query('SELECT * FROM webhook_receipts WHERE provider_event_id = $1', [sid])
    ).rows[0];
    expect(receipt).toMatchObject({ outcome: 'processed', org_id: SEED.orgs.acme.id });
  });

  it('matches an existing lead by phone, whatever format the number arrives in', async () => {
    const leadsBefore = await count('leads');
    await postInbound(app, { From: '(646) 555-0110', To: ACME_NUMBER, Body: 'About my quote' });
    expect(await count('leads')).toBe(leadsBefore);
    const { rows } = await pool.query(
      `SELECT l.name FROM messages m JOIN conversations c ON c.id = m.conversation_id
         JOIN leads l ON l.id = c.lead_id WHERE m.body = 'About my quote'`,
    );
    expect(rows).toEqual([{ name: 'Maria Lopez' }]);
  });

  it('reuses the conversation for a second message', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'one' });
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'two' });
    expect(await count('conversations')).toBe(1);
    expect(await count('messages')).toBe(2);
    expect(await count('workflow_jobs', `type = 'ai_reply'`)).toBe(2);
  });

  it('shows up in the lead’s conversation for staff of that business', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'visible to Acme' });
    const leadId = (await pool.query('SELECT id FROM leads WHERE phone_e164 = $1', [STRANGER]))
      .rows[0].id;
    const res = await request(app)
      .get(`/leads/${leadId}/conversation`)
      .set('Authorization', await bearer('aaron'));
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(['visible to Acme']);
  });
});

describe('the receiving number decides the business', () => {
  it('the same customer texting two businesses becomes a separate lead in each', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'to acme' });
    await postInbound(app, { From: STRANGER, To: BRIGHT_NUMBER, Body: 'to bright' });
    const { rows } = await pool.query(
      `SELECT l.org_id, m.body FROM leads l JOIN conversations c ON c.lead_id = l.id
         JOIN messages m ON m.conversation_id = c.id WHERE l.phone_e164 = $1 ORDER BY m.body`,
      [STRANGER],
    );
    expect(rows).toEqual([
      { org_id: SEED.orgs.acme.id, body: 'to acme' },
      { org_id: SEED.orgs.bright.id, body: 'to bright' },
    ]);
  });

  it('a number no business owns is acknowledged but creates nothing', async () => {
    const sid = newSid();
    const before = await snapshot();
    const res = await postInbound(app, {
      From: STRANGER,
      To: '+14155550100',
      Body: 'hello?',
      MessageSid: sid,
    });
    expect(res.status).toBe(200); // a 4xx/5xx would make Twilio retry forever
    expect(await snapshot()).toEqual({ ...before, receipts: before.receipts + 1 });
    const receipt = (
      await pool.query(
        'SELECT outcome, org_id FROM webhook_receipts WHERE provider_event_id = $1',
        [sid],
      )
    ).rows[0];
    expect(receipt).toEqual({ outcome: 'unroutable', org_id: null });
  });
});

describe('duplicate deliveries (SOW demo 2)', () => {
  it('the same event twice gives one message and one queued reply', async () => {
    const sms = { From: STRANGER, To: ACME_NUMBER, Body: 'only once please', MessageSid: newSid() };
    expect((await postInbound(app, sms)).status).toBe(200);
    const after1 = await snapshot();
    expect((await postInbound(app, sms)).status).toBe(200);
    expect(await snapshot()).toEqual(after1);
    expect(await count('messages')).toBe(1);
    expect(await count('workflow_jobs', `type = 'ai_reply'`)).toBe(1);
  });

  it('five copies arriving at the same moment still give exactly one of everything', async () => {
    const sms = { From: STRANGER, To: ACME_NUMBER, Body: 'racing retries', MessageSid: newSid() };
    const results = await Promise.all(Array.from({ length: 5 }, () => postInbound(app, sms)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await count('webhook_receipts')).toBe(1);
    expect(await count('leads', 'phone_e164 = $1', [STRANGER])).toBe(1);
    expect(await count('messages')).toBe(1);
    expect(await count('workflow_jobs', `type = 'ai_reply'`)).toBe(1);
  });

  it('a failed attempt leaves nothing behind, so Twilio’s retry is processed normally', async () => {
    const sid = newSid();
    // Simulate the database failing partway through: a trigger makes the message insert raise.
    await pool.query(`
      CREATE FUNCTION fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'simulated database failure';
      END $$;
      CREATE TRIGGER fail_once BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION fail_once();`);
    try {
      const sms = { From: STRANGER, To: ACME_NUMBER, Body: 'retry me', MessageSid: sid };
      expect((await postInbound(app, sms)).status).toBe(500);
      expect(await count('webhook_receipts')).toBe(0);
      expect(await count('leads', 'phone_e164 = $1', [STRANGER])).toBe(0);
      // The database recovers; Twilio retries the same event.
      await pool.query('DROP TRIGGER IF EXISTS fail_once ON messages');
      expect((await postInbound(app, sms)).status).toBe(200);
      expect(await count('messages')).toBe(1);
    } finally {
      await pool.query(
        'DROP TRIGGER IF EXISTS fail_once ON messages; DROP FUNCTION IF EXISTS fail_once()',
      );
    }
  });
});

describe('opt-out keywords', () => {
  async function conversationOf(phone: string) {
    return (
      await pool.query(
        'SELECT c.id FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE l.phone_e164 = $1',
        [phone],
      )
    ).rows[0].id as string;
  }

  it('STOP records the opt-out, cancels pending automation and queues no reply', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'first message' });
    const conv = await conversationOf(STRANGER);
    await pool.query(
      `INSERT INTO workflow_jobs (org_id, conversation_id, type, run_at) VALUES ($1, $2, 'follow_up', now() + interval '1 day')`,
      [SEED.orgs.acme.id, conv],
    );

    const res = await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'STOP' });
    expect(res.status).toBe(200);

    expect(await count('opt_outs', 'phone_e164 = $1 AND revoked_at IS NULL', [STRANGER])).toBe(1);
    expect(
      await count('workflow_jobs', `conversation_id = $1 AND status = 'pending'`, [conv]),
    ).toBe(0);
    const reasons = (
      await pool.query(
        'SELECT DISTINCT cancel_reason FROM workflow_jobs WHERE conversation_id = $1',
        [conv],
      )
    ).rows;
    expect(reasons).toEqual([{ cancel_reason: 'opted_out' }]);
    expect(await count('audit_events', `action = 'opt_out.created'`)).toBe(1);
  });

  it('recognizes the standard keywords regardless of case and punctuation, but not inside a sentence', async () => {
    const phones = ['+16465550191', '+16465550192', '+16465550193', '+16465550194'];
    await postInbound(app, { From: phones[0]!, To: ACME_NUMBER, Body: ' stop ' });
    await postInbound(app, { From: phones[1]!, To: ACME_NUMBER, Body: 'Unsubscribe!' });
    await postInbound(app, { From: phones[2]!, To: ACME_NUMBER, Body: 'QUIT.' });
    await postInbound(app, {
      From: phones[3]!,
      To: ACME_NUMBER,
      Body: "please don't stop the plumber",
    });
    for (const p of phones.slice(0, 3))
      expect(await count('opt_outs', 'phone_e164 = $1', [p])).toBe(1);
    expect(await count('opt_outs', 'phone_e164 = $1', [phones[3]])).toBe(0);
  });

  it('later messages from an opted-out number are stored but get no automated reply', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'STOP' });
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'actually, one question' });
    expect(await count('messages')).toBe(2);
    expect(await count('workflow_jobs', `type = 'ai_reply'`)).toBe(0);
  });

  it('an opt-out at one business does not silence another business', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'STOP' });
    await postInbound(app, { From: STRANGER, To: BRIGHT_NUMBER, Body: 'booking question' });
    expect(
      await count('workflow_jobs', `type = 'ai_reply' AND org_id = $1`, [SEED.orgs.bright.id]),
    ).toBe(1);
  });

  it('START lifts the opt-out, keeps the history, and later messages get replies again', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'STOP' });
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'START' });
    expect(await count('opt_outs', 'phone_e164 = $1 AND revoked_at IS NULL', [STRANGER])).toBe(0);
    expect(await count('opt_outs', 'phone_e164 = $1', [STRANGER])).toBe(1);
    expect(await count('workflow_jobs', `type = 'ai_reply'`)).toBe(0); // START itself gets no AI reply
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'can you come Tuesday?' });
    expect(await count('workflow_jobs', `type = 'ai_reply'`)).toBe(1);
  });

  it('a second STOP changes nothing and records nothing', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'STOP' });
    expect((await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'STOP' })).status).toBe(
      200,
    );
    expect(await count('opt_outs')).toBe(1);
    expect(await count('audit_events', `action = 'opt_out.created'`)).toBe(1);
  });
});

describe('automation rules applied on arrival', () => {
  it('a reply from the lead cancels the pending "no reply yet" follow-up', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'first' });
    const conv = (await pool.query('SELECT id FROM conversations')).rows[0].id;
    await pool.query(
      `INSERT INTO workflow_jobs (org_id, conversation_id, type, run_at) VALUES ($1, $2, 'follow_up', now() + interval '1 day')`,
      [SEED.orgs.acme.id, conv],
    );
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'second' });
    const followUps = (
      await pool.query(`SELECT status, cancel_reason FROM workflow_jobs WHERE type = 'follow_up'`)
    ).rows;
    expect(followUps).toEqual([{ status: 'cancelled', cancel_reason: 'lead_replied' }]);
  });

  it('a conversation in Manual mode stores the message but queues no AI reply', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'first' });
    await pool.query(`UPDATE conversations SET mode = 'manual'`);
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'for a human' });
    expect(await count('messages')).toBe(2);
    expect(await count('workflow_jobs', `type = 'ai_reply'`)).toBe(1); // only the first message's
  });

  it('HELP gets no automated reply (the carrier keyword response covers it)', async () => {
    await postInbound(app, { From: STRANGER, To: ACME_NUMBER, Body: 'HELP' });
    expect(await count('messages')).toBe(1);
    expect(await count('workflow_jobs')).toBe(0);
  });
});

describe('payload validation', () => {
  it('rejects a payload without a valid message id', async () => {
    const res = await postInbound(app, {
      From: STRANGER,
      To: ACME_NUMBER,
      Body: 'x',
      MessageSid: 'not-a-sid',
    });
    expect(res.status).toBe(400);
    expect(await count('webhook_receipts')).toBe(0);
  });

  it('acknowledges but ignores a sender that is not a phone number', async () => {
    const res = await postInbound(app, { From: 'ACMEPROMO', To: ACME_NUMBER, Body: 'x' });
    expect(res.status).toBe(200);
    expect(await count('leads', 'source = $1', ['sms'])).toBe(0);
    expect((await pool.query('SELECT outcome FROM webhook_receipts')).rows).toEqual([
      { outcome: 'ignored' },
    ]);
  });
});
