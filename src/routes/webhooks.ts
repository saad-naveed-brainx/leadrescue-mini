import { Router } from 'express';
import { saveInboundSms } from '../services/inboundSms.js';
import { InboundSms } from '../validation.js';

export const webhooksRouter = Router();

// A simulated Twilio "incoming SMS" event. No X-Demo-User here: Twilio isn't a user. The company
// comes from the number that was texted (toNumber).
//
// MOCK: real Twilio signs every webhook. In production we would check the X-Twilio-Signature
// header before reading anything (see README, "Twilio signature verification").
webhooksRouter.post('/webhooks/twilio/inbound', async (req, res) => {
  const sms = InboundSms.parse(req.body);
  const saved = await saveInboundSms(sms);

  // A repeat of a message we already have: nothing new is stored and no AI work is queued.
  // 200, not an error, so Twilio stops retrying.
  if (saved.result === 'duplicate') {
    res.json({ result: 'duplicate' });
    return;
  }

  // The message and its AI reply job are saved. Answer straight away; a worker sends the reply.
  res.json({ ...saved, aiReply: 'queued' });
});
