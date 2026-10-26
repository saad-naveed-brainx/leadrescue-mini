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
