import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db.js';

afterAll(() => db.end());

// vitest.config.ts sets WEB_ORIGIN to this address.
const OUR_WEB_APP = 'https://app.leadrescue.test';

describe('security headers', () => {
  it('every answer carries the standard security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('error answers carry them too', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS allowlist', () => {
  it('our web app may read answers', async () => {
    const res = await request(app).get('/health').set('Origin', OUR_WEB_APP);
    expect(res.headers['access-control-allow-origin']).toBe(OUR_WEB_APP);
  });

  it('another site gets no CORS permission, so the browser blocks it', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a look-alike address is not our web app', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://app.leadrescue.test.evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the browser pre-check for our web app allows the Authorization header and PATCH', async () => {
    const res = await request(app)
      .options('/leads')
      .set('Origin', OUR_WEB_APP)
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(OUR_WEB_APP);
    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('the browser pre-check from another site gets no permission', async () => {
    const res = await request(app)
      .options('/leads')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'DELETE');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('server-to-server callers without an Origin (Twilio, curl) still work', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
