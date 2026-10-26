import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// Demo data: two companies, one user each, and a couple of leads each. All fictional:
// 555-01xx numbers are reserved for fiction, and .test addresses can never be real.
// Fixed ids keep the seed safe to run twice and let tests refer to rows directly.

export const SEED = {
  companyA: {
    id: '0a000000-0000-4000-8000-000000000001',
    name: 'Company A',
    phoneNumber: '+12125550100',
    user: {
      id: '0a000000-0000-4000-8000-0000000000a1',
      email: 'alice@company-a.test',
      name: 'Alice',
    },
  },
  companyB: {
    id: '0b000000-0000-4000-8000-000000000001',
    name: 'Company B',
    phoneNumber: '+13125550100',
    user: { id: '0b000000-0000-4000-8000-0000000000b1', email: 'bob@company-b.test', name: 'Bob' },
  },
} as const;

const LEADS = [
  { tenantId: SEED.companyA.id, name: 'Maria Lopez', phone: '+16465550110' },
  { tenantId: SEED.companyA.id, name: 'James Carter', phone: '+16465550111' },
  { tenantId: SEED.companyB.id, name: 'Sam Rivera', phone: '+17735550110' },
];

/** Inserts the demo companies, users and leads. Safe to run repeatedly: existing rows are kept. */
export async function seed(client: pg.PoolClient): Promise<void> {
  for (const company of [SEED.companyA, SEED.companyB]) {
    await client.query(
      `INSERT INTO tenants (id, name, phone_number) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [company.id, company.name, company.phoneNumber],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [company.user.id, company.id, company.user.email, company.user.name],
    );
  }
  for (const lead of LEADS) {
    await client.query(
      `INSERT INTO leads (tenant_id, name, phone) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, phone) DO NOTHING`,
      [lead.tenantId, lead.name, lead.phone],
    );
  }
}

// Runs only when started from the command line (`npm run seed`), not when a test imports this file.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { db, withTransaction } = await import('../db.js');
  try {
    await withTransaction(seed);
    console.log('seed: 2 companies, 2 users, 3 leads (existing rows kept)');
  } finally {
    await db.end();
  }
}
