import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db.js';
import { seed } from '../src/scripts/seed.js';
import {
  PG,
  SEED,
  SEED_LEADS,
  createConversation,
  leadIdByName,
  pgErrorCode,
  resetDb,
  testPool,
} from './helpers/db.js';

const pool = testPool();
afterAll(() => pool.end());
beforeEach(() => resetDb(pool));

const ACME = SEED.orgs.acme.id;
const BRIGHT = SEED.orgs.bright.id;
const ACME_NUMBER = SEED.phoneNumbers.acme.id;
const BRIGHT_NUMBER = SEED.phoneNumbers.bright.id;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) q`, params);
  return Number(rows[0]!.n);
}

describe('seed data', () => {
  it('creates two tenants with distinct leads, users and memberships', async () => {
    expect(await count('SELECT 1 FROM organizations')).toBe(2);
    expect(await count('SELECT 1 FROM leads WHERE org_id = $1', [ACME])).toBe(25);
    expect(await count('SELECT 1 FROM leads WHERE org_id = $1', [BRIGHT])).toBe(8);
    expect(await count('SELECT 1 FROM organization_memberships WHERE org_id = $1', [ACME])).toBe(2);
    expect(await count('SELECT 1 FROM organization_memberships WHERE org_id = $1', [BRIGHT])).toBe(
      2,
    );
    // The platform admin belongs to no tenant.
    expect(
      await count('SELECT 1 FROM organization_memberships WHERE user_id = $1', [SEED.users.pat.id]),
    ).toBe(0);
  });

  it('is safe to run twice', async () => {
    await withTransaction(seed);
    expect(await count('SELECT 1 FROM leads')).toBe(SEED_LEADS.length);
    expect(await count('SELECT 1 FROM users')).toBe(5);
  });
});

describe('the database rejects rows that cross tenants', () => {
  it('a conversation for another tenant’s lead', async () => {
    const acmeLead = await leadIdByName(pool, 'Maria Lopez');
    const code = await pgErrorCode(
      pool,
      'INSERT INTO conversations (org_id, lead_id, phone_number_id) VALUES ($1, $2, $3)',
      [BRIGHT, acmeLead, BRIGHT_NUMBER],
    );
    expect(code).toBe(PG.FOREIGN_KEY);
  });

  it('a conversation on another tenant’s phone number', async () => {
    const acmeLead = await leadIdByName(pool, 'Maria Lopez');
    const code = await pgErrorCode(
      pool,
      'INSERT INTO conversations (org_id, lead_id, phone_number_id) VALUES ($1, $2, $3)',
      [ACME, acmeLead, BRIGHT_NUMBER],
    );
    expect(code).toBe(PG.FOREIGN_KEY);
  });

  it('a message in another tenant’s conversation', async () => {
    const conv = await createConversation(
      pool,
      ACME,
      await leadIdByName(pool, 'Maria Lopez'),
      ACME_NUMBER,
    );
    const code = await pgErrorCode(
      pool,
      `INSERT INTO messages (org_id, conversation_id, direction, author, body, status)
       VALUES ($1, $2, 'inbound', 'lead', 'hi', 'received')`,
      [BRIGHT, conv],
    );
    expect(code).toBe(PG.FOREIGN_KEY);
  });

  it('a job for another tenant’s conversation', async () => {
    const conv = await createConversation(
      pool,
      ACME,
      await leadIdByName(pool, 'Maria Lopez'),
      ACME_NUMBER,
    );
    const code = await pgErrorCode(
      pool,
      `INSERT INTO workflow_jobs (org_id, conversation_id, type) VALUES ($1, $2, 'ai_reply')`,
      [BRIGHT, conv],
    );
    expect(code).toBe(PG.FOREIGN_KEY);
  });

  it('an opt-out pointing at another tenant’s message', async () => {
    const conv = await createConversation(
      pool,
      ACME,
      await leadIdByName(pool, 'Maria Lopez'),
      ACME_NUMBER,
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages (org_id, conversation_id, direction, author, body, status)
       VALUES ($1, $2, 'inbound', 'lead', 'STOP', 'received') RETURNING id`,
      [ACME, conv],
    );
    const code = await pgErrorCode(
      pool,
      `INSERT INTO opt_outs (org_id, phone_e164, source_message_id) VALUES ($1, '+17735550110', $2)`,
      [BRIGHT, rows[0]!.id],
    );
    expect(code).toBe(PG.FOREIGN_KEY);
  });
});

describe('lead constraints', () => {
  const insertLead = (orgId: string, email: string | null, phone: string | null, status = 'new') =>
    pgErrorCode(
      pool,
      `INSERT INTO leads (org_id, name, email, phone_e164, status, source)
       VALUES ($1, 'Test Person', $2, $3, $4, 'manual')`,
      [orgId, email, phone, status],
    );

  it('one lead per phone within a tenant, but two tenants may share a customer', async () => {
    const existing = SEED_LEADS.find((l) => l.orgId === ACME)!.phoneE164;
    expect(await insertLead(ACME, null, existing)).toBe(PG.UNIQUE);
    expect(await insertLead(BRIGHT, null, existing)).toBeNull();
  });

  it('needs an email or a phone', async () => {
    expect(await insertLead(ACME, null, null)).toBe(PG.CHECK);
  });

  it('rejects malformed phones, non-lower-case emails and unknown statuses', async () => {
    expect(await insertLead(ACME, null, '212-555-0199')).toBe(PG.CHECK);
    expect(await insertLead(ACME, 'Someone@Example.test', null)).toBe(PG.CHECK);
    expect(await insertLead(ACME, 'x@example.test', null, 'won')).toBe(PG.CHECK);
  });
});

describe('duplicate protection', () => {
  it('a receiving number belongs to exactly one tenant', async () => {
    const code = await pgErrorCode(
      pool,
      'INSERT INTO phone_numbers (org_id, e164) VALUES ($1, $2)',
      [BRIGHT, SEED.phoneNumbers.acme.e164],
    );
    expect(code).toBe(PG.UNIQUE);
  });

  it('one webhook receipt per provider event', async () => {
    const insert = `INSERT INTO webhook_receipts (provider, provider_event_id, outcome, payload)
                    VALUES ('twilio', 'SM123', 'processed', '{}')`;
    expect(await pgErrorCode(pool, insert)).toBeNull();
    expect(await pgErrorCode(pool, insert)).toBe(PG.UNIQUE);
  });

  it('one stored message per provider message id and per outbound idempotency key', async () => {
    const conv = await createConversation(
      pool,
      ACME,
      await leadIdByName(pool, 'Maria Lopez'),
      ACME_NUMBER,
    );
    const inbound = `INSERT INTO messages (org_id, conversation_id, direction, author, body, status,
                       provider_message_id) VALUES ($1, $2, 'inbound', 'lead', 'hi', 'received', 'SM1')`;
    expect(await pgErrorCode(pool, inbound, [ACME, conv])).toBeNull();
    expect(await pgErrorCode(pool, inbound, [ACME, conv])).toBe(PG.UNIQUE);

    const outbound = `INSERT INTO messages (org_id, conversation_id, direction, author, body, status,
                        idempotency_key) VALUES ($1, $2, 'outbound', 'ai', 'hello', 'sending', 'ai_reply:x')`;
    expect(await pgErrorCode(pool, outbound, [ACME, conv])).toBeNull();
    expect(await pgErrorCode(pool, outbound, [ACME, conv])).toBe(PG.UNIQUE);
  });

  it('an outbound message must carry an idempotency key', async () => {
    const conv = await createConversation(
      pool,
      ACME,
      await leadIdByName(pool, 'Maria Lopez'),
      ACME_NUMBER,
    );
    const code = await pgErrorCode(
      pool,
      `INSERT INTO messages (org_id, conversation_id, direction, author, body, status)
       VALUES ($1, $2, 'outbound', 'ai', 'hello', 'sending')`,
      [ACME, conv],
    );
    expect(code).toBe(PG.CHECK);
  });

  it('one enqueued job per dedupe key', async () => {
    const insert = `INSERT INTO workflow_jobs (org_id, type, dedupe_key) VALUES ($1, 'ai_reply', 'ai_reply:m1')`;
    expect(await pgErrorCode(pool, insert, [ACME])).toBeNull();
    expect(await pgErrorCode(pool, insert, [ACME])).toBe(PG.UNIQUE);
  });

  it('a running job must hold a lease', async () => {
    const code = await pgErrorCode(
      pool,
      `INSERT INTO workflow_jobs (org_id, type, status) VALUES ($1, 'ai_reply', 'running')`,
      [ACME],
    );
    expect(code).toBe(PG.CHECK);
  });
});

describe('opt-outs', () => {
  const PHONE = '+16465550110';
  const optOut = () =>
    pgErrorCode(
      pool,
      `INSERT INTO opt_outs (org_id, phone_e164, keyword) VALUES ($1, $2, 'STOP')`,
      [ACME, PHONE],
    );

  it('at most one active opt-out per phone, with history kept after re-opt-in', async () => {
    expect(await optOut()).toBeNull();
    expect(await optOut()).toBe(PG.UNIQUE);
    await pool.query(
      'UPDATE opt_outs SET revoked_at = now() WHERE org_id = $1 AND phone_e164 = $2',
      [ACME, PHONE],
    );
    expect(await optOut()).toBeNull();
    expect(await count('SELECT 1 FROM opt_outs WHERE phone_e164 = $1', [PHONE])).toBe(2);
  });

  it('outlive the lead: deleting a lead removes its conversation and jobs but not the opt-out', async () => {
    const lead = await leadIdByName(pool, 'Maria Lopez');
    const phone = SEED_LEADS.find((l) => l.name === 'Maria Lopez')!.phoneE164;
    const conv = await createConversation(pool, ACME, lead, ACME_NUMBER);
    await pool.query(
      `INSERT INTO workflow_jobs (org_id, conversation_id, type) VALUES ($1, $2, 'follow_up')`,
      [ACME, conv],
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO messages (org_id, conversation_id, direction, author, body, status)
       VALUES ($1, $2, 'inbound', 'lead', 'STOP', 'received') RETURNING id`,
      [ACME, conv],
    );
    await pool.query(
      `INSERT INTO opt_outs (org_id, phone_e164, source_message_id) VALUES ($1, $2, $3)`,
      [ACME, phone, rows[0]!.id],
    );

    await pool.query('DELETE FROM leads WHERE id = $1', [lead]);

    expect(await count('SELECT 1 FROM conversations WHERE id = $1', [conv])).toBe(0);
    expect(await count('SELECT 1 FROM workflow_jobs WHERE conversation_id = $1', [conv])).toBe(0);
    // The opt-out survives with its tenant; only the link to the deleted message is cleared.
    expect(
      await count(
        'SELECT 1 FROM opt_outs WHERE org_id = $1 AND phone_e164 = $2 AND source_message_id IS NULL',
        [ACME, phone],
      ),
    ).toBe(1);
  });
});

describe('audit history', () => {
  it('can be added to but never changed, deleted or truncated', async () => {
    await pool.query(
      `INSERT INTO audit_events (org_id, actor_type, action) VALUES ($1, 'system', 'test.event')`,
      [ACME],
    );
    expect(await pgErrorCode(pool, `UPDATE audit_events SET action = 'tampered'`)).toBe(PG.RAISE);
    expect(await pgErrorCode(pool, 'DELETE FROM audit_events')).toBe(PG.RAISE);
    expect(await pgErrorCode(pool, 'TRUNCATE audit_events')).toBe(PG.RAISE);
    expect(await count(`SELECT 1 FROM audit_events WHERE action = 'test.event'`)).toBe(1);
  });
});
