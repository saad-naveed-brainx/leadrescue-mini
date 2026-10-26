import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db.js';
import { aiSender } from '../src/services/aiSender.js';
import { SEED, count, resetDb, sendSms } from './helpers.js';

let aiSends: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb();
  aiSends = vi.spyOn(aiSender, 'send'); // counts real calls to the AI-send stub
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.end());

describe('POST /webhooks/twilio/inbound', () => {
  it('a new customer: creates the lead, the conversation and the message, and the AI replies', async () => {
    const res = await sendSms({ fromNumber: '+16465550199', body: 'Do you fix boilers?' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: 'saved', aiReply: { sent: true } });

    expect(
      await count(`leads WHERE tenant_id = $1 AND phone = '+16465550199'`, [SEED.companyA.id]),
    ).toBe(1);
    expect(
      await count(`messages WHERE direction = 'inbound' AND body = 'Do you fix boilers?'`),
    ).toBe(1);
    expect(await count(`messages WHERE direction = 'outbound' AND author = 'ai'`)).toBe(1);
    expect(aiSends).toHaveBeenCalledTimes(1);
    expect(aiSends.mock.calls[0]![0]).toMatchObject({
      to: '+16465550199',
      from: SEED.companyA.phoneNumber,
    });
  });

  it('an existing lead: the message is added to their existing conversation', async () => {
    const first = await sendSms({ fromNumber: '+16465550110' }); // Maria Lopez, seeded
    const second = await sendSms({ fromNumber: '+16465550110', body: 'Any update?' });
    expect(second.body.leadId).toBe(first.body.leadId);
    expect(second.body.conversationId).toBe(first.body.conversationId);
    expect(await count(`leads WHERE phone = '+16465550110'`)).toBe(1);
    expect(await count(`messages WHERE conversation_id = $1`, [first.body.conversationId])).toBe(4);
  });

  it('the number that was texted decides the company', async () => {
    const res = await sendSms({ toNumber: SEED.companyB.phoneNumber, fromNumber: '+16465550110' });
    // Maria is a lead of Company A; texting Company B makes her a separate lead of B.
    expect(await count(`leads WHERE phone = '+16465550110'`)).toBe(2);
    expect(
      await count(`leads WHERE id = $1 AND tenant_id = $2`, [res.body.leadId, SEED.companyB.id]),
    ).toBe(1);
  });

  it('a number that belongs to no company → 404 and nothing stored', async () => {
    const res = await sendSms({ toNumber: '+19995550100' });
    expect(res.status).toBe(404);
    expect(await count('messages')).toBe(0);
    expect(aiSends).not.toHaveBeenCalled();
  });

  it('a bad payload → 400 and nothing stored', async () => {
    const res = await sendSms({ fromNumber: 'not a phone' });
    expect(res.status).toBe(400);
    expect(await count('messages')).toBe(0);
  });
});

describe('the same messageSid delivered more than once', () => {
  it('twice in a row: one message, one AI reply', async () => {
    const sms = { messageSid: 'SM-repeat-1', fromNumber: '+16465550199' };
    const first = await sendSms(sms);
    const second = await sendSms(sms);

    expect(first.body.result).toBe('saved');
    expect(second.status).toBe(200); // Twilio must not keep retrying
    expect(second.body).toEqual({ result: 'duplicate' });
    expect(await count(`messages WHERE provider_message_id = 'SM-repeat-1'`)).toBe(1);
    expect(await count(`messages WHERE author = 'ai'`)).toBe(1);
    expect(await count(`leads WHERE phone = '+16465550199'`)).toBe(1);
    expect(aiSends).toHaveBeenCalledTimes(1);
  });

  it('10 copies at the same moment: still one message, one lead, one AI reply', async () => {
    const sms = { messageSid: 'SM-burst-1', fromNumber: '+16465550198' };
    const results = await Promise.all(Array.from({ length: 10 }, () => sendSms(sms)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.result === 'saved')).toHaveLength(1);
    expect(results.filter((r) => r.body.result === 'duplicate')).toHaveLength(9);
    expect(await count(`messages WHERE provider_message_id = 'SM-burst-1'`)).toBe(1);
    expect(await count(`leads WHERE phone = '+16465550198'`)).toBe(1);
    expect(await count(`conversations`)).toBe(1);
    expect(await count(`messages WHERE author = 'ai'`)).toBe(1);
    expect(aiSends).toHaveBeenCalledTimes(1);
  });
});
