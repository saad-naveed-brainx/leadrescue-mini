import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { ALICE_A, BOB_B, as, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => db.end());

describe('POST /leads', () => {
  it('creates a lead in the caller’s company', async () => {
    const res = await as(ALICE_A).post('/leads', {
      name: 'Grace Kim',
      phone: '+16465550150',
      email: 'Grace@Example.test',
      notes: 'Wants a quote',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Grace Kim',
      phone: '+16465550150',
      email: 'grace@example.test',
      status: 'new',
      notes: 'Wants a quote',
    });
  });

  it('missing or invalid fields → 400 with the field named', async () => {
    const res = await as(ALICE_A).post('/leads', { phone: '555-1234' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const fields = res.body.error.details.map((d: { path: string }) => d.path);
    expect(fields).toEqual(expect.arrayContaining(['name', 'phone']));
  });

  it('an unknown status → 400', async () => {
    const res = await as(ALICE_A).post('/leads', {
      name: 'X',
      phone: '+16465550150',
      status: 'won',
    });
    expect(res.status).toBe(400);
  });

  it('broken JSON → 400', async () => {
    const res = await as(ALICE_A)
      .post('/leads', {})
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('the same phone twice in one company → 409; another company may have it', async () => {
    const lead = { name: 'Grace Kim', phone: '+16465550150' };
    expect((await as(ALICE_A).post('/leads', lead)).status).toBe(201);
    expect((await as(ALICE_A).post('/leads', lead)).status).toBe(409);
    expect((await as(BOB_B).post('/leads', lead)).status).toBe(201);
  });
});

describe('GET /leads', () => {
  it('lists only the caller’s company’s leads, newest first', async () => {
    await as(ALICE_A).post('/leads', { name: 'Newest', phone: '+16465550150' });
    const res = await as(ALICE_A).get('/leads');
    expect(res.status).toBe(200);
    const names = res.body.leads.map((l: { name: string }) => l.name);
    expect(names[0]).toBe('Newest');
    expect([...names].sort()).toEqual(['James Carter', 'Maria Lopez', 'Newest']);
  });
});

describe('PATCH /leads/:id', () => {
  async function newLeadId() {
    const res = await as(ALICE_A).post('/leads', { name: 'Grace Kim', phone: '+16465550150' });
    return res.body.id as string;
  }

  it('changes the status', async () => {
    const id = await newLeadId();
    const res = await as(ALICE_A).patch(`/leads/${id}`, { status: 'contacted' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('contacted');
  });

  it('changes the notes, and leaves the status alone', async () => {
    const id = await newLeadId();
    await as(ALICE_A).patch(`/leads/${id}`, { status: 'qualified' });
    const res = await as(ALICE_A).patch(`/leads/${id}`, { notes: 'Call after 5pm' });
    expect(res.body).toMatchObject({ status: 'qualified', notes: 'Call after 5pm' });
  });

  it('null clears the notes', async () => {
    const id = await newLeadId();
    await as(ALICE_A).patch(`/leads/${id}`, { notes: 'temp' });
    const res = await as(ALICE_A).patch(`/leads/${id}`, { notes: null });
    expect(res.body.notes).toBeNull();
  });

  it('only status and notes may change; an empty body or other fields → 400', async () => {
    const id = await newLeadId();
    expect((await as(ALICE_A).patch(`/leads/${id}`, {})).status).toBe(400);
    expect((await as(ALICE_A).patch(`/leads/${id}`, { name: 'Renamed' })).status).toBe(400);
    expect((await as(ALICE_A).patch(`/leads/${id}`, { status: 'won' })).status).toBe(400);
  });

  it('an id that does not exist, or is not an id at all → 404', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await as(ALICE_A).patch(`/leads/${missing}`, { status: 'closed' })).status).toBe(404);
    expect((await as(ALICE_A).patch('/leads/not-an-id', { status: 'closed' })).status).toBe(404);
  });
});

describe('errors leak nothing internal', () => {
  it('an unexpected failure answers a plain 500, with no SQL or stack', async () => {
    const original = db.query.bind(db);
    // Make the next query fail like a real database error would.
    db.query = (() => Promise.reject(new Error('relation "leads" syntax at position 42'))) as never;
    try {
      const res = await as(ALICE_A).get('/leads');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'INTERNAL', message: 'Something went wrong' },
      });
    } finally {
      db.query = original;
    }
  });
});
