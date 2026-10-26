import { signToken } from '../../src/auth/tokens.js';
import { SEED } from '../../src/db/seed.js';

type SeedUser = keyof typeof SEED.users;

const HOME_ORG: Partial<Record<SeedUser, string>> = {
  alice: SEED.orgs.acme.id,
  aaron: SEED.orgs.acme.id,
  bella: SEED.orgs.bright.id,
  ben: SEED.orgs.bright.id,
};

/** "Authorization" header value for a seeded user signed in to their own organization. */
export async function bearer(user: SeedUser, orgId = HOME_ORG[user]): Promise<string> {
  if (!orgId) throw new Error(`${user} has no home organization; pass one`);
  return `Bearer ${await signToken({ userId: SEED.users[user].id, orgId })}`;
}
