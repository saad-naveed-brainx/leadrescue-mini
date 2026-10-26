import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testApp } from './helpers/app.js';
import { bearer } from './helpers/auth.js';
import { resetDb } from './helpers/db.js';

const { pool, app } = testApp();
afterAll(() => pool.end());

let alice: string; // owner
let aaron: string; // member
let ben: string; // manager at Bright
beforeEach(async () => {
  await resetDb(pool);
  [alice, aaron, ben] = await Promise.all([bearer('alice'), bearer('aaron'), bearer('ben')]);
});

const create = (token: string, body: object) =>
  request(app).post('/leads').set('Authorization', token).send(body);

describe('creating a lead', () => {
  it('stores normalized contact details and returns the lead', async () => {
    const res = await create(aaron, {
      name: ' New Customer ',
      email: 'New@Example.TEST',
      phone: '(646) 555-0188',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'New Customer',
      email: 'new@example.test',
      phone: '+16465550188',
      status: 'new',
      source: 'manual',
    });
    const fetched = await request(app).get(`/leads/${res.body.id}`).set('Authorization', aaron);
    expect(fetched.body).toEqual(res.body);
  });

  it('reports every invalid field in the standard error shape', async () => {
    const res = await create(alice, { name: '', email: 'nope', phone: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['name', 'email', 'phone']),
    );
  });

  it('needs an email or a phone', async () => {
    const res = await create(alice, { name: 'No Contact' });
    expect(res.status).toBe(400);
  });

  it('refuses a second lead with the same phone in the same organization', async () => {
    const res = await create(alice, { name: 'Dup', phone: '+16465550110' }); // seeded Maria Lopez
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LEAD_PHONE_EXISTS');
  });

  it('records who created it in the audit history', async () => {
    const res = await create(aaron, { name: 'Audited', email: 'audited@x.test' });
    const { rows } = await pool.query(
      `SELECT action, actor_user_id FROM audit_events WHERE target_id = $1`,
      [res.body.id],
    );
    expect(rows).toEqual([{ action: 'lead.created', actor_user_id: expect.any(String) }]);
  });
});

describe('editing a lead', () => {
  async function firstLeadId(token: string) {
    return (await request(app).get('/leads?limit=1').set('Authorization', token)).body.items[0].id;
  }

  it('updates only the fields sent', async () => {
    const id = await firstLeadId(alice);
    const before = (await request(app).get(`/leads/${id}`).set('Authorization', alice)).body;
    const res = await request(app)
      .patch(`/leads/${id}`)
      .set('Authorization', alice)
      .send({ notes: 'Called back' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ...before,
      notes: 'Called back',
      updatedAt: expect.any(String),
    });
  });

  it('changes status and audits the transition', async () => {
    const id = await firstLeadId(alice);
    const before = (await request(app).get(`/leads/${id}`).set('Authorization', alice)).body.status;
    const res = await request(app)
      .patch(`/leads/${id}`)
      .set('Authorization', alice)
      .send({ status: 'qualified' });
    expect(res.body.status).toBe('qualified');
    const { rows } = await pool.query(
      `SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    expect(before).not.toBe('qualified'); // newest seeded lead is 'new'
    expect(rows[0]).toEqual({
      action: 'lead.status_changed',
      metadata: { changed: ['status'], from: before, to: 'qualified' },
    });
  });

  it('rejects an unknown status', async () => {
    const id = await firstLeadId(alice);
    const res = await request(app)
      .patch(`/leads/${id}`)
      .set('Authorization', alice)
      .send({ status: 'won' });
    expect(res.status).toBe(400);
  });

  it('refuses to remove the last way to contact the lead', async () => {
    const created = await create(alice, { name: 'Email Only', email: 'only@x.test' });
    const res = await request(app)
      .patch(`/leads/${created.body.id}`)
      .set('Authorization', alice)
      .send({ email: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a phone already used by another lead', async () => {
    const created = await create(alice, { name: 'Mover', email: 'mover@x.test' });
    const res = await request(app)
      .patch(`/leads/${created.body.id}`)
      .set('Authorization', alice)
      .send({ phone: '+16465550110' });
    expect(res.status).toBe(409);
  });
});

describe('deleting a lead', () => {
  it('owners and managers can delete; the lead is gone afterwards', async () => {
    const created = await create(alice, { name: 'Temp', email: 'temp@x.test' });
    const res = await request(app).delete(`/leads/${created.body.id}`).set('Authorization', alice);
    expect(res.status).toBe(204);
    expect(
      (await request(app).get(`/leads/${created.body.id}`).set('Authorization', alice)).status,
    ).toBe(404);

    const bright = await request(app).get('/leads?limit=1').set('Authorization', ben);
    const byManager = await request(app)
      .delete(`/leads/${bright.body.items[0].id}`)
      .set('Authorization', ben);
    expect(byManager.status).toBe(204);
  });

  it('members cannot delete', async () => {
    const created = await create(alice, { name: 'Keep', email: 'keep@x.test' });
    const res = await request(app).delete(`/leads/${created.body.id}`).set('Authorization', aaron);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(
      (await request(app).get(`/leads/${created.body.id}`).set('Authorization', alice)).status,
    ).toBe(200);
  });
});

describe('listing leads', () => {
  it('pages through every lead exactly once, newest first', async () => {
    const seen: string[] = [];
    const createdAt: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await request(app)
        .get('/leads')
        .query(cursor ? { limit: 10, cursor } : { limit: 10 })
        .set('Authorization', alice);
      expect(res.status).toBe(200);
      for (const l of res.body.items) {
        seen.push(l.id);
        createdAt.push(l.createdAt);
      }
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3); // 25 seeded leads in pages of 10
    expect(new Set(seen).size).toBe(25);
    expect(createdAt).toEqual([...createdAt].sort().reverse());
  });

  it('filters by status', async () => {
    const res = await request(app)
      .get('/leads?status=closed&limit=100')
      .set('Authorization', alice);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((l: { status: string }) => l.status === 'closed')).toBe(true);
  });

  it('searches name, email and phone, case-insensitively', async () => {
    const byName = await request(app).get('/leads?q=maria').set('Authorization', alice);
    expect(byName.body.items.map((l: { name: string }) => l.name)).toEqual(['Maria Lopez']);
    const byPhone = await request(app).get('/leads?q=5550111').set('Authorization', alice);
    expect(byPhone.body.items).toHaveLength(1);
  });

  it('treats % and _ in a search literally', async () => {
    const res = await request(app).get('/leads?q=%25').set('Authorization', alice);
    expect(res.body.items).toEqual([]);
  });

  it('rejects a tampered cursor and an oversized page', async () => {
    expect(
      (await request(app).get('/leads?cursor=garbage').set('Authorization', alice)).status,
    ).toBe(400);
    expect((await request(app).get('/leads?limit=1000').set('Authorization', alice)).status).toBe(
      400,
    );
  });
});

describe('roles', () => {
  it('only owners can read the audit history', async () => {
    expect((await request(app).get('/audit-events').set('Authorization', alice)).status).toBe(200);
    expect((await request(app).get('/audit-events').set('Authorization', aaron)).status).toBe(403);
    expect((await request(app).get('/audit-events').set('Authorization', ben)).status).toBe(403);
  });
});
