// Must stay the first import: it lowers the limits to 3 a minute before the app loads.
import './helpers/lowRateLimits.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db.js';
import { SEED, resetDb } from './helpers/db.js';
import { postInbound } from './helpers/twilio.js';

beforeAll(() => resetDb(db));
afterAll(() => db.end());

describe('dev-login rate limit', () => {
  it('allows 3 sign-ins a minute, then answers 429 in the usual error shape', async () => {
    const login = () => request(app).post('/auth/dev-login').send({ userId: SEED.users.ben.id });
    for (let i = 0; i < 3; i++) expect((await login()).status).toBe(200);

    const res = await login();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.requestId).toBeDefined();
    expect(res.headers['ratelimit-policy']).toBeDefined();
  });

  it('only the login is limited; other routes still answer', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/auth/dev-identities')).status).toBe(200);
  });
});

describe('webhook rate limit', () => {
  const sms = { From: '+15550001111', To: '+15550000000', Body: 'hi' };

  it('counts unsigned junk too, before the signature check, then answers 429', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await postInbound(app, sms, { signature: null })).status).toBe(403);
    }
    const res = await postInbound(app, sms, { signature: null });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('once over the limit, even a properly signed webhook waits and stores nothing', async () => {
    const before = await db.query('SELECT count(*)::int AS n FROM webhook_receipts');
    const res = await postInbound(app, sms);
    expect(res.status).toBe(429);
    const after = await db.query('SELECT count(*)::int AS n FROM webhook_receipts');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
