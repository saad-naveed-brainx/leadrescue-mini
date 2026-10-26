import type { Role } from '@lr/shared';
import type { RequestHandler } from 'express';
import type { Pool } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { can, type Permission } from './rbac.js';
import { verifyToken } from './tokens.js';

/** Who is calling, established by the server. Handlers take the tenant from here and nowhere else. */
export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const unauthenticated = (message = 'Sign in required') =>
  new AppError(401, 'UNAUTHENTICATED', message);

/**
 * 1. The bearer token must be genuine and unexpired.
 * 2. The user must exist and not be suspended.
 * 3. The user must still be a member of the organization named in the token.
 * Steps 2 and 3 hit the database on every request, so a suspension or a removed membership takes
 * effect immediately instead of when the token expires.
 */
export function requireAuth(pool: Pool): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match) throw unauthenticated();

    const claims = await verifyToken(match[1]!);
    if (!claims) throw unauthenticated('Invalid or expired session');

    const { rows } = await pool.query<{ suspended: boolean; role: Role | null }>(
      `SELECT u.suspended_at IS NOT NULL AS suspended, m.role
         FROM users u
         LEFT JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = $2
        WHERE u.id = $1`,
      [claims.userId, claims.orgId],
    );
    const row = rows[0];
    if (!row) throw unauthenticated('Invalid or expired session');
    if (row.suspended) throw new AppError(401, 'ACCOUNT_SUSPENDED', 'This account is suspended');
    if (!row.role)
      throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this organization');

    req.auth = { userId: claims.userId, orgId: claims.orgId, role: row.role };
    next();
  };
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthenticated();
    if (!can(req.auth.role, permission)) {
      throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this action');
    }
    next();
  };
}

/** The verified caller. Only valid on routes behind requireAuth. */
export function authOf(req: { auth?: AuthContext }): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}
