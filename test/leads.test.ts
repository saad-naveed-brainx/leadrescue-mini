import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { ALICE_A, BOB_B, SEED, as, count, resetDb, sendSms } from './helpers.js';

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
  it("each lead carries its conversation's id once the customer has texted", async () => {
    const sms = await sendSms({ fromNumber: '+16465550110' }); // Maria Lopez texts Company A
    const res = await as(ALICE_A).get('/leads');
    const maria = res.body.leads.find((l: { name: string }) => l.name === 'Maria Lopez');
    const james = res.body.leads.find((l: { name: string }) => l.name === 'James Carter');
    expect(maria.conversationId).toBe(sms.body.conversationId);
    expect(james.conversationId).toBeNull();
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

describe('GET /leads paging and status filter', () => {
  // Each call gets its own block of phone numbers (one lead per phone per company).
  let batch = 0;

  /** Adds `n` leads to Company A. With sameTime, they all get exactly the same created_at. */
  async function addLeads(n: number, options: { sameTime?: boolean; status?: string } = {}) {
    batch += 1;
    await db.query(
      `INSERT INTO leads (tenant_id, name, phone, status, created_at)
       SELECT $1, 'Bulk ' || i, '+164677' || $5 || lpad(i::text, 4, '0'), $3,
              CASE WHEN $2 THEN timestamptz '2026-01-01 12:00:00'
                   ELSE timestamptz '2026-01-01 12:00:00' + i * interval '1 minute' END
         FROM generate_series(1, $4) AS i`,
      [SEED.companyA.id, options.sameTime ?? false, options.status ?? 'new', n, batch],
    );
  }

  /** Follows nextCursor until the end; returns every lead id, in order, and the page sizes. */
  async function readAllPages(user: string, query: string) {
    const ids: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/leads?${query}${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await as(user).get(url);
      expect(res.status).toBe(200);
      ids.push(...res.body.leads.map((l: { id: string }) => l.id));
      sizes.push(res.body.leads.length);
      cursor = res.body.nextCursor;
    } while (cursor);
    return { ids, sizes };
  }

  it('walks every lead exactly once, newest first, page by page', async () => {
    await addLeads(120); // + 2 seeded leads = 122
    const { ids, sizes } = await readAllPages(ALICE_A, 'limit=50');
    expect(sizes).toEqual([50, 50, 22]);
    expect(new Set(ids).size).toBe(122);

    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC',
      [SEED.companyA.id],
    );
    expect(ids).toEqual(rows.map((r) => r.id));
  });

  it('leads with exactly the same created_at are neither skipped nor repeated', async () => {
    await addLeads(30, { sameTime: true });
    const { ids } = await readAllPages(ALICE_A, 'limit=7');
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
  });

  it('leads one microsecond apart are all returned (the cursor keeps full precision)', async () => {
    await db.query(
      `INSERT INTO leads (tenant_id, name, phone, created_at)
       SELECT $1, 'Micro ' || i, '+16467880' || lpad(i::text, 3, '0'),
              timestamptz '2027-01-01 12:00:00' + i * interval '1 microsecond'
         FROM generate_series(1, 5) AS i`,
      [SEED.companyA.id],
    );
    const { ids } = await readAllPages(ALICE_A, 'limit=1');
    expect(ids).toHaveLength(7); // 5 + 2 seeded
    expect(new Set(ids).size).toBe(7);
  });

  it('a lead added between two pages does not shift or repeat the next page', async () => {
    await addLeads(20);
    const first = await as(ALICE_A).get('/leads?limit=10');
    await as(ALICE_A).post('/leads', { name: 'Brand new', phone: '+16465550150' });
    const second = await as(ALICE_A).get(`/leads?limit=10&cursor=${first.body.nextCursor}`);

    const firstIds = first.body.leads.map((l: { id: string }) => l.id);
    const secondIds = second.body.leads.map((l: { id: string }) => l.id);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
    expect(second.body.leads.map((l: { name: string }) => l.name)).not.toContain('Brand new');
  });

  it('the status filter returns only that status, paged the same way', async () => {
    await addLeads(15, { status: 'qualified' });
    await addLeads(5); // 'new'
    const { ids, sizes } = await readAllPages(ALICE_A, 'status=qualified&limit=10');
    expect(sizes).toEqual([10, 5]);
    expect(await count(`leads WHERE id = ANY($1::uuid[]) AND status = 'qualified'`, [ids])).toBe(
      15,
    );
  });

  it('the last page says there is no next page', async () => {
    const res = await as(ALICE_A).get('/leads?limit=50');
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();
  });

  it("another company's cursor shows only your own company's leads", async () => {
    await addLeads(10);
    const alicePage = await as(ALICE_A).get('/leads?limit=3');
    const bob = await as(BOB_B).get(`/leads?cursor=${alicePage.body.nextCursor}`);
    expect(bob.status).toBe(200);
    expect(bob.body.leads.every((l: { name: string }) => l.name === 'Sam Rivera')).toBe(true);
  });

  it('bad paging input → 400', async () => {
    const bad = [
      '/leads?cursor=not-a-cursor',
      '/leads?limit=0',
      '/leads?limit=101',
      '/leads?limit=abc',
      '/leads?status=won',
      '/leads?sort=name',
    ];
    for (const url of bad) {
      const res = await as(ALICE_A).get(url);
      expect(res.status, url).toBe(400);
    }
    expect((await as(ALICE_A).get('/leads?cursor=not-a-cursor')).body.error.code).toBe(
      'INVALID_CURSOR',
    );
  });
});
