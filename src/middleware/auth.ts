import type { RequestHandler } from 'express';
import { db } from '../db.js';
import { AppError } from './errors.js';

/** Who is calling, and which company they belong to. Looked up in the database, never taken
 *  from the request body, query or another header, so the company can't be faked. */
export interface CurrentUser {
  userId: string;
  tenantId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: CurrentUser;
  }
}

/**
 * MOCK LOGIN, for this exercise only. The caller names a seeded user by email in the
 * X-Demo-User header, and we look up that user's company.
 *
 * Not production authentication: anyone who knows (or guesses) an email can act as that user.
 * Nothing proves the caller is really that person: no password, no signed token, no expiry.
 * Production would use a real identity provider and a signed, expiring session token, and
 * would still look the company up on the server exactly as below.
 */
export const requireUser: RequestHandler = async (req, _res, next) => {
  const email = req.header('x-demo-user')?.trim().toLowerCase();
  if (!email) throw new AppError(401, 'UNAUTHENTICATED', 'Missing X-Demo-User header');

  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    'SELECT id, tenant_id FROM users WHERE email = $1',
    [email],
  );
  if (!rows[0]) throw new AppError(401, 'UNAUTHENTICATED', 'Unknown demo user');

  req.user = { userId: rows[0].id, tenantId: rows[0].tenant_id };
  next();
};

/** The signed-in caller. Only valid on routes behind requireUser. */
export function currentUser(req: { user?: CurrentUser }): CurrentUser {
  if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
  return req.user;
}
