import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { computeTwilioSignature } from '../../src/utils/twilioSignature.js';

// Must match vitest.config.ts.
const TOKEN = 'test-only-twilio-token-0000';
const BASE = 'https://api.leadrescue.test';
const PATH = '/webhooks/twilio/inbound';

export const newSid = () => `SM${randomBytes(16).toString('hex')}`;

export interface InboundSms {
  From: string;
  To: string;
  Body: string;
  MessageSid?: string;
}

/** Posts an inbound SMS exactly as Twilio would, signature included. */
export function postInbound(
  app: Express,
  sms: InboundSms,
  opts: { signature?: string | null } = {},
) {
  const params: Record<string, string> = {
    AccountSid: 'AC00000000000000000000000000000000',
    NumMedia: '0',
    MessageSid: sms.MessageSid ?? newSid(),
    From: sms.From,
    To: sms.To,
    Body: sms.Body,
  };
  const req = request(app).post(PATH).type('form').send(params);
  const signature =
    opts.signature === undefined
      ? computeTwilioSignature(TOKEN, BASE + PATH, params)
      : opts.signature;
  return signature === null ? req : req.set('X-Twilio-Signature', signature);
}

/** A customer texts a business; returns the conversation that text landed in. */
export async function customerTexts(app: Express, from: string, to: string, body: string) {
  const res = await postInbound(app, { From: from, To: to, Body: body });
  if (res.status !== 200) throw new Error(`inbound webhook answered ${res.status}`);
  const { db } = await import('../../src/db.js');
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id FROM conversations c JOIN leads l ON l.org_id = c.org_id AND l.id = c.lead_id
       JOIN phone_numbers p ON p.org_id = c.org_id AND p.e164 = $2
      WHERE l.phone_e164 = $1`,
    [from, to],
  );
  return rows[0]!.id;
}
