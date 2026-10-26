import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';
import { bearer } from './helpers/auth.js';
import { SEED, createConversation, resetDb } from './helpers/db.js';

// The SOW's first required demonstration: Tenant A creates a lead; Tenant B cannot view, edit or
// delete it, even by guessing its id. Here B doesn't even have to guess: the tests use the real id.

const { pool, app } = testApp();
afterAll(() => pool.end());

let acmeLeadId: string;
let acme: string; // Alice, owner at Acme
let bright: string; // Bella, owner at Bright: has every permission, just not in Acme

beforeEach(async () => {
  await resetDb(pool);
  acme = await bearer('alice');
  bright = await bearer('bella');
  const created = await request(app).post('/leads').set('Authorization', acme).send({
    name: 'Secret Acme Customer',
    email: 'secret@acme-customer.test',
    phone: '646-555-0177',
  });
  expect(created.status).toBe(201);
  acmeLeadId = created.body.id;
});

async function acmeLeadInDb() {
  const { rows } = await pool.query('SELECT name, email, status FROM leads WHERE id = $1', [
    acmeLeadId,
  ]);
  return rows[0];
}

describe('another tenant cannot reach a lead by its id', () => {
  it('cannot view it', async () => {
    const res = await request(app).get(`/leads/${acmeLeadId}`).set('Authorization', bright);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('Secret');
  });

  it('cannot edit it, and the stored lead is unchanged', async () => {
    const res = await request(app)
      .patch(`/leads/${acmeLeadId}`)
      .set('Authorization', bright)
      .send({ name: 'Hijacked', status: 'closed' });
    expect(res.status).toBe(404);
    expect(await acmeLeadInDb()).toEqual({
      name: 'Secret Acme Customer',
      email: 'secret@acme-customer.test',
      status: 'new',
    });
  });

  it('cannot delete it, and the lead still exists', async () => {
    const res = await request(app).delete(`/leads/${acmeLeadId}`).set('Authorization', bright);
    expect(res.status).toBe(404);
    expect(await acmeLeadInDb()).toBeDefined();
  });

  it('cannot read its conversation', async () => {
    const conv = await createConversation(
      pool,
      SEED.orgs.acme.id,
      acmeLeadId,
      SEED.phoneNumbers.acme.id,
    );
    await pool.query(
      `INSERT INTO messages (org_id, conversation_id, direction, author, body, status)
       VALUES ($1, $2, 'inbound', 'lead', 'my private message', 'received')`,
      [SEED.orgs.acme.id, conv],
    );
    const res = await request(app)
      .get(`/leads/${acmeLeadId}/conversation`)
      .set('Authorization', bright);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('private');
    // The owner can.
    const own = await request(app)
      .get(`/leads/${acmeLeadId}/conversation`)
      .set('Authorization', acme);
    expect(own.body.messages[0].body).toBe('my private message');
  });

  it('answers exactly as for an id that does not exist, so ids cannot be probed', async () => {
    const other = await request(app).get(`/leads/${acmeLeadId}`).set('Authorization', bright);
    const missing = await request(app)
      .get('/leads/00000000-0000-4000-8000-000000000000')
      .set('Authorization', bright);
    expect(other.status).toBe(missing.status);
    expect(other.body.error.code).toBe(missing.body.error.code);
    expect(other.body.error.message).toBe(missing.body.error.message);
  });
});

describe('lists and search never leak across tenants', () => {
  it('lists only the caller’s own leads', async () => {
    const res = await request(app).get('/leads?limit=100').set('Authorization', bright);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(8);
    expect(res.body.items.map((l: { id: string }) => l.id)).not.toContain(acmeLeadId);
  });

  it('search for another tenant’s customer finds nothing', async () => {
    for (const q of ['Secret', 'acme-customer', '0177']) {
      const res = await request(app).get('/leads').query({ q }).set('Authorization', bright);
      expect(res.body.items).toEqual([]);
    }
  });
});

describe('the client cannot choose the tenant', () => {
  it('rejects an org id in the request body instead of using it', async () => {
    const res = await request(app)
      .post('/leads')
      .set('Authorization', bright)
      .send({ name: 'Planted', email: 'planted@x.test', orgId: SEED.orgs.acme.id });
    expect(res.status).toBe(400);
    const { rows } = await pool.query(`SELECT 1 FROM leads WHERE name = 'Planted'`);
    expect(rows).toHaveLength(0);
  });

  it('ignores an org id in the query string', async () => {
    const res = await request(app)
      .get('/leads')
      .query({ orgId: SEED.orgs.acme.id })
      .set('Authorization', bright);
    // Unknown query parameters are rejected outright, not silently used.
    expect(res.status).toBe(400);
  });

  it('a new lead always lands in the caller’s organization', async () => {
    const res = await request(app)
      .post('/leads')
      .set('Authorization', bright)
      .send({ name: 'Bright Newcomer', phone: '773-555-0177' });
    const { rows } = await pool.query('SELECT org_id FROM leads WHERE id = $1', [res.body.id]);
    expect(rows[0].org_id).toBe(SEED.orgs.bright.id);
  });
});

describe('audit history is per tenant', () => {
  it('an owner sees only their own organization’s events', async () => {
    const res = await request(app).get('/audit-events').set('Authorization', bright);
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { targetId: string }) => e.targetId)).not.toContain(acmeLeadId);
    const own = await request(app).get('/audit-events').set('Authorization', acme);
    expect(own.body.items.map((e: { targetId: string }) => e.targetId)).toContain(acmeLeadId);
  });

  it('pages through the whole history without repeats', async () => {
    for (let i = 0; i < 4; i++) {
      await request(app)
        .patch(`/leads/${acmeLeadId}`)
        .set('Authorization', acme)
        .send({ notes: `n${i}` });
    }
    const ids: string[] = [];
    let before: string | null = null;
    do {
      const res: request.Response = await request(app)
        .get('/audit-events')
        .query(before ? { limit: 2, before } : { limit: 2 })
        .set('Authorization', acme);
      expect(res.status).toBe(200);
      ids.push(...res.body.items.map((e: { id: string }) => e.id));
      before = res.body.nextBefore;
    } while (before);
    expect(ids).toHaveLength(5); // 1 created + 4 updates
    expect(new Set(ids).size).toBe(5);
  });
});
