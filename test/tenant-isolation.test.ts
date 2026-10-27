import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db.js';
import { ALICE_A, BOB_B, SEED, as, count, resetDb, sendSms } from './helpers.js';

beforeEach(resetDb);
afterAll(() => db.end());

async function createLeadForA() {
  const res = await as(ALICE_A).post('/leads', { name: 'Grace Kim', phone: '+16465550150' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('a user from Company B can never see or change Company A data', () => {
  it('a lead created by A is listed for A and not for B', async () => {
    const id = await createLeadForA();

    const aList = await as(ALICE_A).get('/leads');
    expect(aList.body.leads.map((l: { id: string }) => l.id)).toContain(id);

    const bList = await as(BOB_B).get('/leads');
    expect(bList.body.leads.map((l: { id: string }) => l.id)).not.toContain(id);
    expect(bList.body.leads.every((l: { name: string }) => l.name !== 'Grace Kim')).toBe(true);
  });

  it("B reading A's lead by its id gets 404, as if it didn't exist", async () => {
    const id = await createLeadForA();
    const res = await as(BOB_B).get(`/leads/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('Grace Kim');
  });

  it("B updating A's lead gets 404 and nothing changes", async () => {
    const id = await createLeadForA();
    const res = await as(BOB_B).patch(`/leads/${id}`, { status: 'closed', notes: 'hijacked' });
    expect(res.status).toBe(404);

    const lead = await as(ALICE_A).get(`/leads/${id}`);
    expect(lead.body.status).toBe('new');
    expect(lead.body.notes).toBeNull();
  });

  it("B can't read A's conversation or take it over", async () => {
    const sms = await sendSms(); // a customer texts Company A
    const conversationId = sms.body.conversationId;

    expect((await as(BOB_B).get(`/conversations/${conversationId}`)).status).toBe(404);
    const handoff = await as(BOB_B).post(`/conversations/${conversationId}/handoff`, {
      mode: 'MANUAL',
    });
    expect(handoff.status).toBe(404);
    expect(await count(`conversations WHERE id = $1 AND mode = 'AI'`, [conversationId])).toBe(1);
  });

  it('the company comes from the user, never from the request', async () => {
    // Bob (Company B) tries to create a lead in Company A by naming it.
    const res = await as(BOB_B).post('/leads', {
      name: 'Sneaky',
      phone: '+16465550151',
      tenantId: SEED.companyA.id,
    });
    expect(res.status).toBe(400);
    expect(await count(`leads WHERE name = 'Sneaky'`)).toBe(0);

    // A tenant id in the query string or a header is ignored: Bob still sees only B's leads.
    const list = await request(app)
      .get(`/leads?tenantId=${SEED.companyA.id}`)
      .set('X-Demo-User', BOB_B)
      .set('X-Tenant-Id', SEED.companyA.id);
    expect(list.body.leads.map((l: { name: string }) => l.name)).toEqual(['Sam Rivera']);
  });

  it('the database itself refuses a message pointing at another company’s conversation', async () => {
    const sms = await sendSms(); // conversation belongs to Company A
    const insert = db.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, author, body, send_status)
       VALUES ($1, $2, 'outbound', 'ai', 'cross-company', 'sent')`,
      [SEED.companyB.id, sms.body.conversationId],
    );
    await expect(insert).rejects.toMatchObject({ code: '23503' }); // foreign key violation
  });
});

describe('signing in (mock X-Demo-User)', () => {
  it('no header → 401', async () => {
    const res = await request(app).get('/leads');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('an unknown user → 401', async () => {
    const res = await as('nobody@nowhere.test').get('/leads');
    expect(res.status).toBe(401);
  });
});
