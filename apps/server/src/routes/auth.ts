import type { DevIdentityDto, MeDto, Role } from '@lr/shared';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { authOf, permissionsFor, requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { loginRateLimit } from '../middleware/rateLimits.js';
import { signToken } from '../utils/tokens.js';

export const authRouter = Router();

const DevLoginInput = z.strictObject({ userId: z.uuid(), orgId: z.uuid().optional() });

// The dev login (the SOW's "documented local authentication adapter"): anyone can sign in as any
// seeded user, which is why config.ts refuses to start in production. What it hands out is a normal
// signed token, and every later request is checked exactly as a real login's token would be.

// The people the login screen offers, with the businesses each belongs to.
authRouter.get('/auth/dev-identities', async (_req, res) => {
  const { rows } = await db.query<{
    user_id: string;
    name: string;
    email: string;
    org_id: string;
    org_name: string;
    role: Role;
  }>(
    `SELECT u.id AS user_id, u.name, u.email, o.id AS org_id, o.name AS org_name, m.role
       FROM users u
       JOIN organization_memberships m ON m.user_id = u.id
       JOIN organizations o ON o.id = m.org_id
      WHERE u.suspended_at IS NULL
      ORDER BY o.name, u.name`,
  );
  const byUser = new Map<string, DevIdentityDto>();
  for (const r of rows) {
    const identity = byUser.get(r.user_id) ?? {
      userId: r.user_id,
      name: r.name,
      email: r.email,
      memberships: [],
    };
    identity.memberships.push({ orgId: r.org_id, orgName: r.org_name, role: r.role });
    byUser.set(r.user_id, identity);
  }
  res.json({ identities: [...byUser.values()] });
});

authRouter.post('/auth/dev-login', loginRateLimit, async (req, res) => {
  const input = DevLoginInput.parse(req.body);
  const { rows } = await db.query<{ org_id: string; suspended: boolean }>(
    `SELECT m.org_id, u.suspended_at IS NOT NULL AS suspended
       FROM users u JOIN organization_memberships m ON m.user_id = u.id
      WHERE u.id = $1`,
    [input.userId],
  );
  // One answer for "no such user", "no memberships" and "suspended", so sign-in can't be used to
  // learn which accounts exist or what state they are in.
  if (rows.length === 0 || rows[0]!.suspended) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign-in refused');
  }

  let orgId = input.orgId;
  if (!orgId) {
    if (rows.length > 1) {
      throw new AppError(
        400,
        'ORG_REQUIRED',
        'This user belongs to several organizations; pick one',
      );
    }
    orgId = rows[0]!.org_id;
  }
  if (!rows.some((r) => r.org_id === orgId)) {
    throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this organization');
  }
  res.json({ token: await signToken({ userId: input.userId, orgId }) });
});

// Who am I signed in as, in which business, and what may I do?
authRouter.get('/me', requireAuth, async (req, res) => {
  const auth = authOf(req);
  const { rows } = await db.query<{ name: string; email: string; org_name: string }>(
    `SELECT u.name, u.email, o.name AS org_name
       FROM users u, organizations o WHERE u.id = $1 AND o.id = $2`,
    [auth.userId, auth.orgId],
  );
  const row = rows[0];
  // Only possible if the user or business was deleted after requireAuth's check.
  if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired session');
  const me: MeDto = {
    user: { id: auth.userId, name: row.name, email: row.email },
    org: { id: auth.orgId, name: row.org_name },
    role: auth.role,
    permissions: permissionsFor(auth.role),
  };
  res.json(me);
});
