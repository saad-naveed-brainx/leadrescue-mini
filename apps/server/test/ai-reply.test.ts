import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db.js';
import { looksLikeLink } from '../src/services/aiReply.js';
import { mockAi } from '../src/services/mockAi.js';
import { mockSms } from '../src/services/mockSms.js';
import { sendAutomatedMessage } from '../src/services/sendMessage.js';
import { testApp } from './helpers/app.js';
import { SEED, resetDb } from './helpers/db.js';
import { postInbound } from './helpers/twilio.js';
import { drainQueue, providerSends } from './helpers/worker.js';

const { app } = testApp();
afterAll(() => db.end());
beforeEach(() => resetDb(db));
afterEach(() => vi.restoreAllMocks());

const ACME = SEED.orgs.acme.id;
const ACME_NUMBER = SEED.phoneNumbers.acme.e164;
const BRIGHT_NUMBER = SEED.phoneNumbers.bright.e164;
const CUSTOMER = '+16465550190';

/** The customer texts a business; returns the ids of that conversation and message. */
async function customerTexts(body: string, to: string = ACME_NUMBER) {
  await postInbound(app, { From: CUSTOMER, To: to, Body: body }).expect(200);
  const { rows } = await db.query<{ conversationId: string; messageId: string; orgId: string }>(
    `SELECT m.conversation_id AS "conversationId", m.id AS "messageId", m.org_id AS "orgId"
       FROM messages m WHERE m.direction = 'inbound' ORDER BY m.created_at DESC LIMIT 1`,
  );
  return rows[0]!;
}

async function jobStatuses() {
  const { rows } = await db.query<{ status: string; cancel_reason: string | null }>(
    `SELECT status, cancel_reason FROM workflow_jobs WHERE type = 'ai_reply' ORDER BY created_at`,
  );
  return rows;
}

async function outboundMessages() {
  const { rows } = await db.query(
    `SELECT author, status, body, idempotency_key, provider_message_id
       FROM messages WHERE direction = 'outbound' ORDER BY created_at`,
  );
  return rows;
}

/** Calls the send gate directly, the way the worker does. */
function send(conversationId: string, key = 'test:1', body = 'Hello from the test') {
  return sendAutomatedMessage({
    orgId: ACME,
    conversationId,
    body,
    idempotencyKey: key,
    author: 'ai',
  });
}

describe('an AI reply, end to end (SOW demo 3)', () => {
  it('a customer text becomes one AI reply, sent from the business number to the customer', async () => {
    const { messageId } = await customerTexts('Do you do weekend callouts?');
    await drainQueue();

    expect(await jobStatuses()).toEqual([{ status: 'succeeded', cancel_reason: null }]);
    const [reply] = await outboundMessages();
    expect(reply).toMatchObject({
      author: 'ai',
      status: 'sent',
      idempotency_key: `ai_reply:${messageId}`,
    });
    expect(reply.provider_message_id).toMatch(/^SM/);
    expect(reply.body).toContain('Acme Plumbing');

    const sends = await providerSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ client_ref: `ai_reply:${messageId}`, to_e164: CUSTOMER });
  });

  it('the AI only sees this conversation: not other customers, not other businesses', async () => {
    await customerTexts('Bright secret: my dentist appointment', BRIGHT_NUMBER);
    // Another Acme customer, already answered earlier.
    await postInbound(app, { From: '+16465550191', To: ACME_NUMBER, Body: 'Other customer here' });
    await drainQueue();
    await customerTexts('Hello Acme');
    const ai = vi.spyOn(mockAi, 'generateReply');
    await drainQueue();

    expect(ai).toHaveBeenCalledTimes(1); // only the new text; the others were answered above
    const acmeCall = ai.mock.calls.find(([input]) => input.businessName === 'Acme Plumbing')![0];
    expect(acmeCall.messages.map((m) => m.body)).toEqual(['Hello Acme']);
  });

  it('two texts in a row get one reply, to the latest', async () => {
    await customerTexts('Hi');
    await customerTexts('Actually, how much is a boiler service?');
    await drainQueue();

    expect(await jobStatuses()).toEqual([
      { status: 'cancelled', cancel_reason: 'superseded' },
      { status: 'succeeded', cancel_reason: null },
    ]);
    expect(await providerSends()).toHaveLength(1);
    expect((await outboundMessages())[0].body).toContain('quote');
  });
});

describe('the final checks before sending', () => {
  it('staff switched to Manual after the reply was queued: nothing is sent', async () => {
    const { conversationId } = await customerTexts('Hi');
    await db.query(`UPDATE conversations SET mode = 'manual' WHERE id = $1`, [conversationId]);
    await drainQueue();

    expect(await jobStatuses()).toEqual([{ status: 'cancelled', cancel_reason: 'manual_mode' }]);
    expect(await providerSends()).toHaveLength(0);
  });

  it('STOP after the reply was queued: nothing is sent', async () => {
    await customerTexts('Hi');
    await customerTexts('STOP');
    await drainQueue();
    expect(await providerSends()).toHaveLength(0);
  });

  it('the gate itself refuses an opted-out customer, and records why', async () => {
    const { conversationId } = await customerTexts('STOP');
    expect(await send(conversationId)).toEqual({ outcome: 'blocked', reason: 'opted_out' });
    expect(await providerSends()).toHaveLength(0);
    const audit = await db.query(
      `SELECT metadata->>'reason' AS reason FROM audit_events WHERE action = 'message.suppressed'`,
    );
    expect(audit.rows).toEqual([{ reason: 'opted_out' }]);
  });

  it('the gate refuses a closed lead', async () => {
    const { conversationId } = await customerTexts('Hi');
    await db.query(`UPDATE leads SET status = 'closed' WHERE phone_e164 = $1`, [CUSTOMER]);
    expect(await send(conversationId)).toEqual({ outcome: 'blocked', reason: 'lead_closed' });
    expect(await providerSends()).toHaveLength(0);
  });
});

describe('never the same text twice', () => {
  it('sending with the same key again does nothing', async () => {
    const { conversationId } = await customerTexts('Hi');
    expect((await send(conversationId)).outcome).toBe('sent');
    expect((await send(conversationId)).outcome).toBe('already_sent');
    expect(await providerSends()).toHaveLength(1);
  });

  it('five sends with the same key at the same moment give exactly one text', async () => {
    const { conversationId } = await customerTexts('Hi');
    const results = await Promise.all(Array.from({ length: 5 }, () => send(conversationId)));
    expect(results.filter((r) => r.outcome === 'sent')).toHaveLength(1);
    expect(await providerSends()).toHaveLength(1);
  });

  it('a crash right after the SMS service accepted the text: the retry notices and does not resend', async () => {
    const { conversationId } = await customerTexts('Hi');
    const realSend = mockSms.send;
    vi.spyOn(mockSms, 'send').mockImplementationOnce(async (sms) => {
      await realSend(sms); // the text really went out...
      throw new Error('connection lost'); // ...but we never heard back
    });

    await expect(send(conversationId)).rejects.toThrow('connection lost');
    expect((await outboundMessages())[0].status).toBe('sending');

    expect((await send(conversationId)).outcome).toBe('sent');
    expect((await outboundMessages())[0].status).toBe('sent');
    expect(await providerSends()).toHaveLength(1);
  });

  it('a failure before the SMS service accepted it: the retry sends it, once', async () => {
    const { conversationId } = await customerTexts('Hi');
    vi.spyOn(mockSms, 'send').mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(send(conversationId)).rejects.toThrow('provider unavailable');
    expect(await providerSends()).toHaveLength(0);

    expect((await send(conversationId)).outcome).toBe('sent');
    expect(await providerSends()).toHaveLength(1);
  });
});

describe('when the AI misbehaves', () => {
  it('an AI failure is retried later and then succeeds', async () => {
    await customerTexts('Hi');
    vi.spyOn(mockAi, 'generateReply').mockRejectedValueOnce(new Error('AI timed out'));
    await drainQueue();
    expect(await jobStatuses()).toEqual([{ status: 'pending', cancel_reason: null }]);
    expect(await providerSends()).toHaveLength(0);

    await db.query('UPDATE workflow_jobs SET run_at = now()'); // fast-forward the retry wait
    await drainQueue();
    expect(await jobStatuses()).toEqual([{ status: 'succeeded', cancel_reason: null }]);
    expect(await providerSends()).toHaveLength(1);
  });

  it('an AI reply containing a link never reaches the customer', async () => {
    await customerTexts('Hi');
    vi.spyOn(mockAi, 'generateReply').mockResolvedValueOnce('Pay here: https://example.test/pay');
    await drainQueue();
    expect(await jobStatuses()).toEqual([{ status: 'dead', cancel_reason: null }]);
    expect(await providerSends()).toHaveLength(0);
  });
});

describe('the link check on AI replies', () => {
  it('catches every common link shape', () => {
    for (const text of [
      'Pay at https://x.test/pay',
      'see www.acme-deals.com',
      'go to acme-deals.com/pay now',
      'call tel:+16465550100',
      'write to mailto:a@b.test',
    ]) {
      expect(looksLikeLink(text), text).toBe(true);
    }
  });

  it('lets ordinary replies through', () => {
    expect(looksLikeLink('Thanks for texting Acme Plumbing. We got your message.')).toBe(false);
    expect(looksLikeLink('Sorry to hear that! Is this the best number to reach you?')).toBe(false);
  });
});
