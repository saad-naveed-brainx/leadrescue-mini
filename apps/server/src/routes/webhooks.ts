import express, { Router, type RequestHandler } from 'express';
import { config } from '../config.js';
import { AppError } from '../middleware/errors.js';
import { webhookRateLimit } from '../middleware/rateLimits.js';
import { TwilioInbound, handleInboundSms } from '../services/inboundSms.js';
import { type WebhookParams, isValidTwilioSignature } from '../utils/twilioSignature.js';

/**
 * The parsed form body, checked to be what express.urlencoded produces: names mapped to a string,
 * or to several strings for a repeated name. Anything else means the parsers are misconfigured.
 */
function formParams(body: unknown): WebhookParams {
  const ok =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    Object.values(body).every(
      (v) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')),
    );
  if (!ok) throw new AppError(400, 'INVALID_WEBHOOK_BODY', 'Expected a form-encoded body');
  return body as WebhookParams;
}

// An empty TwiML response: "received, nothing to say". The reply, if any, is sent later by the worker.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Rejects any request not signed with our Twilio auth token, before anything is read or stored. */
export function requireTwilioSignature(authToken: string, publicBaseUrl: string): RequestHandler {
  return (req, _res, next) => {
    const url = publicBaseUrl + req.originalUrl;
    const params = formParams(req.body ?? {});
    if (!isValidTwilioSignature(authToken, url, params, req.header('x-twilio-signature'))) {
      throw new AppError(403, 'INVALID_SIGNATURE', 'Webhook signature is missing or invalid');
    }
    next();
  };
}

export const webhooksRouter = Router();

webhooksRouter.use(
  '/webhooks/twilio',
  webhookRateLimit,
  // Twilio posts form-encoded bodies; flat parsing is all it needs.
  express.urlencoded({ extended: false, limit: '64kb' }),
  requireTwilioSignature(config.TWILIO_AUTH_TOKEN, config.PUBLIC_BASE_URL),
);

webhooksRouter.post('/webhooks/twilio/inbound', async (req, res) => {
  const params = formParams(req.body);
  const msg = TwilioInbound.parse(params);
  // Everything is stored and any reply is queued before we answer, so a 200 means "safe".
  // A failure answers 500 and Twilio retries; the retry is deduplicated by the receipt.
  await handleInboundSms(msg, params, req.requestId);
  res.type('text/xml').send(EMPTY_TWIML);
});
