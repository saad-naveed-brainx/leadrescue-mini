import type { Role } from '@lr/shared';
import type { RequestHandler } from 'express';
import { db } from '../db.js';
import { verifyToken } from '../utils/tokens.js';
import { AppError } from './errors.js';

/** Who is calling. Set by requireAuth from the verified token and the database, never from the
 *  request body, so the business (orgId) can't be faked. */
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

export type Permission =
  'leads:read' | 'leads:write' | 'leads:delete' | 'conversations:mode' | 'audit:read';

// What each role may do. The server checks this on every route; the web app only uses it to hide
// buttons. (The platform admin is not a role here.)
const PERMISSIONS: Record<Role, Permission[]> = {
  owner: ['leads:read', 'leads:write', 'leads:delete', 'conversations:mode', 'audit:read'],
  manager: ['leads:read', 'leads:write', 'leads:delete', 'conversations:mode'],
  member: ['leads:read', 'leads:write', 'conversations:mode'],
};

export function permissionsFor(role: Role): Permission[] {
  return PERMISSIONS[role];
}

function unauthenticated(message = 'Sign in required') {
  return new AppError(401, 'UNAUTHENTICATED', message);
}

/**
 * Lets a request through only if:
 * 1. it carries a genuine, unexpired login token,
 * 2. the user still exists and isn't suspended,
 * 3. the user is still a member of the business named in the token.
 * Steps 2 and 3 read the database on every request, so a suspension or a removed membership takes
 * effect at once instead of when the token expires.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) throw unauthenticated();

  const claims = await verifyToken(match[1]!);
  if (!claims) throw unauthenticated('Invalid or expired session');

  const { rows } = await db.query<{ suspended: boolean; role: Role | null }>(
    `SELECT u.suspended_at IS NOT NULL AS suspended, m.role
       FROM users u
       LEFT JOIN organization_memberships m ON m.user_id = u.id AND m.org_id = $2
      WHERE u.id = $1`,
    [claims.userId, claims.orgId],
  );
  const row = rows[0];
  if (!row) throw unauthenticated('Invalid or expired session');
  if (row.suspended) throw new AppError(401, 'ACCOUNT_SUSPENDED', 'This account is suspended');
  if (!row.role) {
    throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this organization');
  }

  req.auth = { userId: claims.userId, orgId: claims.orgId, role: row.role };
  next();
};

/** Lets a request through only if the caller's role has this permission. Use after requireAuth. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthenticated();
    if (!permissionsFor(req.auth.role).includes(permission)) {
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
