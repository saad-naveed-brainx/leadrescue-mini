import { randomBytes } from 'node:crypto';
import { db } from '../db.js';

// The pretend text-message service, standing in for Twilio. Nothing is sent to a real phone: each
// "sent" text is written to mock_provider_messages, which plays the part of Twilio's own records.
// That table deliberately allows duplicates (real Twilio does too), so if our code ever sent the
// same reply twice, tests would see two rows.

export interface SmsToSend {
  from: string;
  to: string;
  body: string;
  /** Our label for this send (the message's idempotency key), so we can look it up later. */
  clientRef: string;
}

async function send(sms: SmsToSend): Promise<{ sid: string }> {
  // A real provider call would have a timeout of a few seconds here.
  const sid = `SM${randomBytes(16).toString('hex')}`;
  await db.query(
    `INSERT INTO mock_provider_messages (sid, client_ref, from_e164, to_e164, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [sid, sms.clientRef, sms.from, sms.to, sms.body],
  );
  return { sid };
}

/** "Did you already send this one?" Used after a crash, to avoid sending it a second time. */
async function findByClientRef(clientRef: string): Promise<{ sid: string } | null> {
  const { rows } = await db.query<{ sid: string }>(
    'SELECT sid FROM mock_provider_messages WHERE client_ref = $1 ORDER BY created_at LIMIT 1',
    [clientRef],
  );
  return rows[0] ?? null;
}

// Exported as an object so tests can swap a function out (for example, to make sending fail).
export const mockSms = { send, findByClientRef };
