import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db.js';
import { processPendingAiReply } from '../src/services/aiReply.js';
import { aiSender } from '../src/services/aiSender.js';
import { ALICE_A, as, count, drainJobs, resetDb, sendSms } from './helpers.js';

let aiSends: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb();
  aiSends = vi.spyOn(aiSender, 'send');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.end());

/** A customer texts Company A; returns the conversation id (the AI has answered that first text). */
async function startConversation(fromNumber = '+16465550199') {
  const res = await sendSms({ fromNumber });
  await drainJobs(); // the worker answers the first text
  return res.body.conversationId as string;
}

const handoff = (conversationId: string, mode: 'AI' | 'MANUAL') =>
  as(ALICE_A).post(`/conversations/${conversationId}/handoff`, { mode });

describe('POST /conversations/:id/handoff', () => {
  it('switches to MANUAL and back to AI', async () => {
    const id = await startConversation();
    const manual = await handoff(id, 'MANUAL');
    expect(manual.status).toBe(200);
    expect(manual.body.mode).toBe('MANUAL');

    const back = await handoff(id, 'AI');
    expect(back.body.mode).toBe('AI');
  });

  it('a bad mode, or a conversation that does not exist → 400 / 404', async () => {
    const id = await startConversation();
    expect((await as(ALICE_A).post(`/conversations/${id}/handoff`, { mode: 'human' })).status).toBe(
      400,
    );
    expect((await handoff('00000000-0000-4000-8000-000000000000', 'MANUAL')).status).toBe(404);
  });
});

describe('MANUAL stops the AI', () => {
  it('after a switch to MANUAL, a new customer text is saved but the AI sends nothing', async () => {
    const id = await startConversation();
    aiSends.mockClear(); // forget the reply to the first text
    await handoff(id, 'MANUAL');

    await sendSms({ fromNumber: '+16465550199', body: 'Hello? Anyone there?' });
    await drainJobs(); // the worker runs the job, sees MANUAL, sends nothing
    expect(await count(`jobs WHERE status = 'done'`)).toBe(2); // both texts' jobs finished
    expect(await count(`messages WHERE body = 'Hello? Anyone there?'`)).toBe(1);
    expect(aiSends).not.toHaveBeenCalled();
  });

  it('processPendingAiReply checks the mode itself, right before sending', async () => {
    const id = await startConversation();
    await handoff(id, 'MANUAL');
    await sendSms({ fromNumber: '+16465550199', body: 'still there?' });
    aiSends.mockClear();

    // Called directly (as a background worker would), it still refuses.
    expect(await processPendingAiReply(id)).toEqual({ sent: false, reason: 'manual_mode' });
    expect(aiSends).not.toHaveBeenCalled();
  });

  it('back to AI: the waiting message gets its reply', async () => {
    const id = await startConversation();
    await handoff(id, 'MANUAL');
    await sendSms({ fromNumber: '+16465550199', body: 'still there?' });
    aiSends.mockClear();

    await handoff(id, 'AI');
    expect(await processPendingAiReply(id)).toMatchObject({ sent: true });
    expect(aiSends).toHaveBeenCalledTimes(1);
  });

  it('running the AI step again for an answered message sends nothing (no duplicate AI work)', async () => {
    const id = await startConversation();
    aiSends.mockClear();
    const results = await Promise.all([processPendingAiReply(id), processPendingAiReply(id)]);
    expect(results).toEqual([
      { sent: false, reason: 'nothing_pending' },
      { sent: false, reason: 'nothing_pending' },
    ]);
    expect(aiSends).not.toHaveBeenCalled();
  });
  it('the database allows only one AI reply per customer message, even if the code slipped', async () => {
    const id = await startConversation(); // the AI already replied to this first text
    const { rows } = await db.query<{ tenant_id: string; id: string }>(
      `SELECT tenant_id, id FROM messages WHERE conversation_id = $1 AND direction = 'inbound'`,
      [id],
    );
    const second = db.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, author, body, reply_to_message_id)
       VALUES ($1, $2, 'outbound', 'ai', 'second reply', $3)`,
      [rows[0]!.tenant_id, id, rows[0]!.id],
    );
    await expect(second).rejects.toMatchObject({ code: '23505' }); // unique rule broken
  });
});

describe('the race between the AI sending and a hand-off', () => {
  it('a hand-off during a send waits for it; once MANUAL is confirmed, nothing more is sent', async () => {
    const id = await startConversation();
    await handoff(id, 'MANUAL');
    await sendSms({ fromNumber: '+16465550199', body: 'question' }); // waits, unanswered
    await handoff(id, 'AI');

    // Make the stub's send slow, so the hand-off below arrives while the AI is mid-send.
    aiSends.mockImplementation(async () => {
      await sleep(300);
    });

    const aiStep = processPendingAiReply(id);
    await sleep(50); // the AI step now holds the conversation lock and is "sending"
    const startedAt = Date.now();
    const manual = await handoff(id, 'MANUAL');
    const waitedMs = Date.now() - startedAt;

    expect(manual.status).toBe(200);
    expect(await aiStep).toMatchObject({ sent: true }); // it had started before the hand-off
    expect(waitedMs).toBeGreaterThan(150); // the hand-off waited for that send to finish

    // From the confirmed hand-off on, nothing goes out.
    aiSends.mockClear();
    await sendSms({ fromNumber: '+16465550199', body: 'after handoff' });
    expect(await processPendingAiReply(id)).toEqual({ sent: false, reason: 'manual_mode' });
    expect(aiSends).not.toHaveBeenCalled();
  });

  it('50 rounds of AI step vs hand-off at the same moment: never a send after MANUAL is confirmed', async () => {
    for (let round = 0; round < 50; round++) {
      const id = await startConversation(`+164655502${String(round).padStart(2, '0')}`);
      await handoff(id, 'MANUAL');
      await sendSms({ fromNumber: `+164655502${String(round).padStart(2, '0')}`, body: 'q' });
      await handoff(id, 'AI');

      let confirmedAt = 0;
      const sendTimes: number[] = [];
      aiSends.mockImplementation(async () => {
        sendTimes.push(Date.now());
        await sleep(Math.random() * 5);
      });

      await Promise.all([
        processPendingAiReply(id),
        handoff(id, 'MANUAL').then(() => (confirmedAt = Date.now())),
      ]);
      // Whichever won, no send happened after the hand-off was confirmed.
      for (const t of sendTimes) expect(t).toBeLessThanOrEqual(confirmedAt);
      aiSends.mockReset();
    }
  });
});
