import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';

const key = new TextEncoder().encode(config.AUTH_JWT_SECRET);
const ISSUER = 'leadrescue-mini';
const AUDIENCE = 'leadrescue-api';

/** What a token proves: who signed in, and which of their organizations they chose. Nothing else. */
export interface TokenClaims {
  userId: string;
  orgId: string;
}

export async function signToken(claims: TokenClaims, ttlSeconds = config.AUTH_TOKEN_TTL_SECONDS) {
  return new SignJWT({ org: claims.orgId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(key);
}

/** Returns the claims of a genuine, unexpired token, or null for anything else. */
export async function verifyToken(token: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.org !== 'string') return null;
    return { userId: payload.sub, orgId: payload.org };
  } catch {
    return null;
  }
}
