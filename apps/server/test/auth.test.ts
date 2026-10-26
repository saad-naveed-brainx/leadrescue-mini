import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { signToken } from '../src/auth/tokens.js';
import { testApp } from './helpers/app.js';
import { bearer } from './helpers/auth.js';
import { SEED, resetDb } from './helpers/db.js';

const { pool, app } = testApp();
afterAll(() => pool.end());
beforeEach(() => resetDb(pool));

describe('test-identity login', () => {
  it('lists the seeded staff with their organizations, but not the platform admin', async () => {
    const res = await request(app).get('/auth/dev-identities');
    expect(res.status).toBe(200);
    const emails = res.body.identities.map((i: { email: string }) => i.email);
    expect(emails.sort()).toEqual([
      'aaron@acme.test',
      'alice@acme.test',
      'bella@bright.test',
      'ben@bright.test',
    ]);
  });

  it('issues a token that works for /me', async () => {
    const login = await request(app).post('/auth/dev-login').send({ userId: SEED.users.ben.id });
    expect(login.status).toBe(200);
    const me = await request(app).get('/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      user: { email: 'ben@bright.test' },
      org: { id: SEED.orgs.bright.id, name: 'Bright Dental' },
      role: 'manager',
    });
    expect(me.body.permissions).toContain('leads:delete');
    expect(me.body.permissions).not.toContain('audit:read');
  });

  it('refuses to sign someone in to an organization they do not belong to', async () => {
    const res = await request(app)
      .post('/auth/dev-login')
      .send({ userId: SEED.users.alice.id, orgId: SEED.orgs.bright.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_A_MEMBER');
  });

  it('gives one answer for unknown, membership-less and suspended accounts', async () => {
    await pool.query('UPDATE users SET suspended_at = now() WHERE id = $1', [SEED.users.ben.id]);
    const attempts = await Promise.all(
      ['00000000-0000-4000-8000-000000000000', SEED.users.pat.id, SEED.users.ben.id].map((userId) =>
        request(app).post('/auth/dev-login').send({ userId }),
      ),
    );
    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Sign-in refused' });
    }
  });
});

describe('every protected request is verified by the server', () => {
  it('rejects a missing, malformed or forged token', async () => {
    expect((await request(app).get('/leads')).status).toBe(401);
    expect((await request(app).get('/leads').set('Authorization', 'Bearer nonsense')).status).toBe(
      401,
    );
    // A structurally valid token signed with some other key.
    const forged = (await bearer('alice')).replace(
      /\.[^.]+$/,
      '.c2lnbmF0dXJlLWZyb20tc29tZW9uZS1lbHNl',
    );
    expect((await request(app).get('/leads').set('Authorization', forged)).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const expired = await signToken({ userId: SEED.users.alice.id, orgId: SEED.orgs.acme.id }, -60);
    const res = await request(app).get('/leads').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('re-checks suspension on every request, not only at login', async () => {
    const token = await bearer('alice');
    expect((await request(app).get('/leads').set('Authorization', token)).status).toBe(200);
    await pool.query('UPDATE users SET suspended_at = now() WHERE id = $1', [SEED.users.alice.id]);
    const res = await request(app).get('/leads').set('Authorization', token);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('re-checks membership on every request, so removing someone takes effect immediately', async () => {
    const token = await bearer('aaron');
    await pool.query('DELETE FROM organization_memberships WHERE user_id = $1', [
      SEED.users.aaron.id,
    ]);
    const res = await request(app).get('/leads').set('Authorization', token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_A_MEMBER');
  });

  it('does not trust the organization inside a genuine token without a membership behind it', async () => {
    const res = await request(app)
      .get('/leads')
      .set('Authorization', await bearer('alice', SEED.orgs.bright.id));
    expect(res.status).toBe(403);
  });
});
