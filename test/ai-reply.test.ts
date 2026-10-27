import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db.js';
import { processPendingAiReply } from '../src/services/aiReply.js';
import { aiSender } from '../src/services/aiSender.js';
import { withConversationLock } from '../src/services/conversationLock.js';
import { runWorkerOnce } from '../src/services/worker.js';
import { ALICE_A, as, count, drainJobs, resetDb, sendSms } from './helpers.js';

const realSend = aiSender.send;
const realWriteReply = aiSender.writeReply;

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.end());

const handoff = (conversationId: string, mode: 'AI' | 'MANUAL') =>
  as(ALICE_A).post(`/conversations/${conversationId}/handoff`, { mode });

const replyRow = async () =>
  (await db.query(`SELECT send_status, provider_message_id FROM messages WHERE author = 'ai'`))
    .rows;

describe('step A: the AI writes without holding the lock', () => {
  it('a hand-off during a slow AI call answers at once, and then nothing is sent', async () => {
    const sms = await sendSms({ fromNumber: '+16465550199' }); // queued, not yet run
    vi.spyOn(aiSender, 'writeReply').mockImplementation(async (name) => {
      await sleep(500); // a slow AI
      return realWriteReply(name);
    });
    const sends = vi.spyOn(aiSender, 'send');

    const aiStep = processPendingAiReply(sms.body.conversationId);
    await sleep(50); // the AI is now "thinking"
    const startedAt = Date.now();
    const manual = await handoff(sms.body.conversationId, 'MANUAL');
    expect(manual.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(300); // didn't wait for the AI

    expect(await aiStep).toEqual({ sent: false, reason: 'manual_mode' });
    expect(sends).not.toHaveBeenCalled();
    expect(await count('messages WHERE author = $1', ['ai'])).toBe(0);
  });

  it('a newer customer message arriving while the AI writes is left to its own job', async () => {
    const first = await sendSms({ fromNumber: '+16465550199', body: 'first' });
    vi.spyOn(aiSender, 'writeReply').mockImplementationOnce(async (name) => {
      await sendSms({ fromNumber: '+16465550199', body: 'second' }); // arrives meanwhile
      return realWriteReply(name);
    });
    expect(await processPendingAiReply(first.body.conversationId)).toEqual({
      sent: false,
      reason: 'nothing_pending',
    });
    await drainJobs(); // the second message's job answers it
    expect(await count(`messages WHERE author = 'ai' AND send_status = 'sent'`)).toBe(1);
  });
});

describe('a crash between sending and recording never sends twice', () => {
  it('provider has it but we never recorded it: the retry records it without sending again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The provider takes the SMS, then the worker "dies" before step D.
    vi.spyOn(aiSender, 'send').mockImplementationOnce(async (sms) => {
      await realSend(sms);
      throw new Error('worker died after the provider sent');
    });
    await sendSms({ fromNumber: '+16465550199' });

    await runWorkerOnce();
    expect(await replyRow()).toMatchObject([{ send_status: 'sending' }]);
    expect(await count('mock_sms_sent')).toBe(1);

    await db.query('UPDATE jobs SET run_at = now()'); // retry now
    await drainJobs();
    expect(await count('mock_sms_sent')).toBe(1); // still one SMS
    const [reply] = await replyRow();
    expect(reply).toMatchObject({ send_status: 'sent' });
    expect(reply.provider_message_id).toMatch(/^SM/);
  });

  it('saved "sending" but the provider never got it, and now MANUAL: cancelled, not sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(aiSender, 'send').mockRejectedValueOnce(new Error('provider unreachable'));
    const sms = await sendSms({ fromNumber: '+16465550199' });
    await runWorkerOnce(); // reply saved as 'sending', send failed

    await handoff(sms.body.conversationId, 'MANUAL');
    await db.query('UPDATE jobs SET run_at = now()');
    await drainJobs();

    expect(await replyRow()).toMatchObject([{ send_status: 'cancelled' }]);
    expect(await count('mock_sms_sent')).toBe(0);
    // A cancelled reply never went out, so it isn't shown in the conversation.
    const conversation = await as(ALICE_A).get(`/conversations/${sms.body.conversationId}`);
    expect(conversation.body.messages.map((m: { author: string }) => m.author)).toEqual([
      'customer',
    ]);
  });

  it('a real worker process killed right after the provider sent: one SMS, recorded on retry', async () => {
    const sms = await sendSms({ fromNumber: '+16465550199' });

    // Start a real worker that pauses (for 10 s) after the provider has the SMS.
    const worker: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MOCK_SMS_PAUSE_MS: '10000',
        WORKER_CONCURRENCY: '1',
        DB_POOL_SIZE: '4',
        WORKER_POLL_MS: '50',
      },
      stdio: 'ignore',
    });
    try {
      // Wait until the provider has the SMS (the worker is now paused before step D) ...
      for (let i = 0; i < 200 && (await count('mock_sms_sent')) === 0; i++) await sleep(50);
      expect(await count('mock_sms_sent')).toBe(1);
    } finally {
      // ... and kill it, as a crash or a hard deploy would.
      worker.kill('SIGKILL');
      await new Promise((resolve) => worker.once('exit', resolve));
    }
    expect(await replyRow()).toMatchObject([{ send_status: 'sending' }]);

    // PostgreSQL released the dead worker's lock: a hand-off works straight away.
    expect((await handoff(sms.body.conversationId, 'AI')).status).toBe(200);

    // Its claim on the job expires; another worker retries the job.
    await db.query(`UPDATE jobs SET locked_until = now() - interval '1 second'`);
    await drainJobs();
    expect(await count('mock_sms_sent')).toBe(1); // the customer got exactly one SMS
    expect(await replyRow()).toMatchObject([{ send_status: 'sent' }]);
  });
});

describe('the hand-off time limit', () => {
  it('if a send holds the lock for more than 5 s, the hand-off answers 503 and changes nothing', async () => {
    const sms = await sendSms({ fromNumber: '+16465550199' });
    await drainJobs();
    const id = sms.body.conversationId;

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Something (a stuck send) holds the conversation lock.
    const holder = withConversationLock(id, () => held);
    await sleep(50);

    const startedAt = Date.now();
    const res = await handoff(id, 'MANUAL');
    const waited = Date.now() - startedAt;
    release();
    await holder;

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CONVERSATION_BUSY');
    expect(waited).toBeGreaterThanOrEqual(4900);
    expect(waited).toBeLessThan(7000);
    expect(await count(`conversations WHERE id = $1 AND mode = 'AI'`, [id])).toBe(1);
  });
});
