import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db.js';

afterAll(() => db.end());
// Undo any fake database answers so they can't leak into the next test.
afterEach(() => vi.restoreAllMocks());

describe('health endpoints', () => {
  it('reports liveness', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports the database as reachable', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('reports 503 when the database is unreachable', async () => {
    // Pretend the database is down for this one query.
    vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('unreachable');
  });
});

describe('error responses and request ids', () => {
  it('returns the standard JSON error shape for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes a well-formed X-Request-Id', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'test-req-12345');
    expect(res.headers['x-request-id']).toBe('test-req-12345');
  });

  it('replaces a malformed X-Request-Id instead of trusting it', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'bad id <script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects malformed JSON with a 400 in the standard shape', async () => {
    const res = await request(app)
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});
