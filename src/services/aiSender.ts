import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { db } from '../db.js';

// The stubbed AI and SMS provider. Nothing real is called:
// - writeReply plays the AI: a fixed, friendly reply. A real AI call would take seconds.
// - send plays Twilio's "send message": it records the SMS in mock_sms_sent (the provider's own
//   record of what it sent) and returns a provider message id.
// - findSent plays "look up a message I sent": used after a crash, to avoid sending twice.
//
// It is an object so tests can watch or replace a function (vi.spyOn(aiSender, 'send')).

export interface OutgoingSms {
  to: string;
  from: string;
  body: string;
  /** Our id for this send (the reply message's id), so it can be looked up later. */
  clientRef: string;
}

async function writeReply(companyName: string): Promise<string> {
  return `Thanks for texting ${companyName}! We got your message and someone will get back to you shortly.`;
}

async function send(sms: OutgoingSms): Promise<{ sid: string }> {
  const sid = `SM${randomUUID().replaceAll('-', '')}`;
  await db.query(
    `INSERT INTO mock_sms_sent (sid, client_ref, to_number, from_number, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [sid, sms.clientRef, sms.to, sms.from, sms.body],
  );
  // TEST ONLY: pause after the provider has the message, so a test can kill the worker at the
  // worst moment (sent, but not yet recorded as sent). Ignored outside NODE_ENV=test.
  const pauseMs = process.env.NODE_ENV === 'test' ? Number(process.env.MOCK_SMS_PAUSE_MS ?? 0) : 0;
  if (pauseMs > 0) await sleep(pauseMs);
  return { sid };
}

/** "Did you already send this?" The provider's message id, or null if it never went out. */
async function findSent(clientRef: string): Promise<string | null> {
  const { rows } = await db.query<{ sid: string }>(
    'SELECT sid FROM mock_sms_sent WHERE client_ref = $1 ORDER BY created_at LIMIT 1',
    [clientRef],
  );
  return rows[0]?.sid ?? null;
}

export const aiSender = { writeReply, send, findSent };
