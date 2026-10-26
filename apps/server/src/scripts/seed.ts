import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

// All seed data is fictional. 555-0100..0199 numbers are reserved for fiction in North America,
// and .test domains can never be real addresses.
// Fixed ids keep the seed idempotent and let the login screen and tests refer to people by id.

export const SEED = {
  orgs: {
    acme: {
      id: '0a000000-0000-4000-8000-000000000001',
      name: 'Acme Plumbing',
      slug: 'acme-plumbing',
    },
    bright: {
      id: '0b000000-0000-4000-8000-000000000001',
      name: 'Bright Dental',
      slug: 'bright-dental',
    },
  },
  phoneNumbers: {
    acme: { id: '0a000000-0000-4000-8000-0000000000f1', e164: '+12125550100', label: 'Main line' },
    bright: {
      id: '0b000000-0000-4000-8000-0000000000f1',
      e164: '+13125550100',
      label: 'Front desk',
    },
  },
  users: {
    alice: {
      id: '0a000000-0000-4000-8000-0000000000a1',
      email: 'alice@acme.test',
      name: 'Alice Owner',
    },
    aaron: {
      id: '0a000000-0000-4000-8000-0000000000a2',
      email: 'aaron@acme.test',
      name: 'Aaron Member',
    },
    bella: {
      id: '0b000000-0000-4000-8000-0000000000b1',
      email: 'bella@bright.test',
      name: 'Bella Owner',
    },
    ben: {
      id: '0b000000-0000-4000-8000-0000000000b2',
      email: 'ben@bright.test',
      name: 'Ben Manager',
    },
    pat: {
      id: '0c000000-0000-4000-8000-0000000000c1',
      email: 'pat@leadrescue.test',
      name: 'Pat Platform',
    },
  },
} as const;

const MEMBERSHIPS = [
  { org: SEED.orgs.acme.id, user: SEED.users.alice.id, role: 'owner' },
  { org: SEED.orgs.acme.id, user: SEED.users.aaron.id, role: 'member' },
  { org: SEED.orgs.bright.id, user: SEED.users.bella.id, role: 'owner' },
  { org: SEED.orgs.bright.id, user: SEED.users.ben.id, role: 'manager' },
] as const;

const STATUSES = ['new', 'contacted', 'qualified', 'closed'] as const;
const ACME_NAMES = [
  'Maria Lopez',
  'James Carter',
  'Priya Shah',
  'Tom Becker',
  'Grace Kim',
  'Luis Ortega',
  'Hannah Moore',
  'Omar Haddad',
  'Chloe Martin',
  'Daniel Wu',
  'Sofia Rossi',
  'Ethan Brooks',
  'Ava Nguyen',
  'Noah Fischer',
  'Mia Johnson',
  "Liam O'Brien",
  'Zara Ali',
  'Lucas Silva',
  'Ella Novak',
  'Mason Reed',
  'Ivy Chen',
  'Leo Dubois',
  'Nora Patel',
  'Owen Hughes',
  'Ruby Clarke',
];
const BRIGHT_NAMES = [
  'Sam Rivera',
  'Kate Walsh',
  'Arjun Mehta',
  'Lena Vogel',
  'Ben Adeyemi',
  'Rosa Diaz',
  'Felix Wong',
  'Iris Park',
];

export interface SeedLead {
  orgId: string;
  name: string;
  email: string;
  phoneE164: string;
  status: (typeof STATUSES)[number];
  createdAt: string;
}

function leadsFor(orgId: string, names: string[], areaCode: string, domain: string): SeedLead[] {
  const base = Date.UTC(2026, 9, 1, 9, 0, 0); // 2026-10-01 09:00 UTC
  return names.map((name, i) => ({
    orgId,
    name,
    email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${domain}`,
    phoneE164: `+1${areaCode}55501${String(i + 10).padStart(2, '0')}`,
    status: STATUSES[i % STATUSES.length]!,
    // One lead per hour so the list order (newest first) is stable.
    createdAt: new Date(base + i * 3_600_000).toISOString(),
  }));
}

export const SEED_LEADS: SeedLead[] = [
  ...leadsFor(SEED.orgs.acme.id, ACME_NAMES, '646', 'example.test'),
  ...leadsFor(SEED.orgs.bright.id, BRIGHT_NAMES, '773', 'example.test'),
];

/** Inserts the demo tenants, people and leads. Safe to run repeatedly: existing rows are left alone. */
export async function seed(client: pg.PoolClient): Promise<void> {
  for (const org of Object.values(SEED.orgs)) {
    await client.query(
      'INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [org.id, org.name, org.slug],
    );
  }
  const numbers = [
    { ...SEED.phoneNumbers.acme, orgId: SEED.orgs.acme.id },
    { ...SEED.phoneNumbers.bright, orgId: SEED.orgs.bright.id },
  ];
  for (const n of numbers) {
    await client.query(
      `INSERT INTO phone_numbers (id, org_id, e164, label) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [n.id, n.orgId, n.e164, n.label],
    );
  }
  for (const u of Object.values(SEED.users)) {
    await client.query(
      `INSERT INTO users (id, email, name, is_platform_admin) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [u.id, u.email, u.name, u.id === SEED.users.pat.id],
    );
  }
  for (const m of MEMBERSHIPS) {
    await client.query(
      `INSERT INTO organization_memberships (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [m.org, m.user, m.role],
    );
  }
  for (const l of SEED_LEADS) {
    await client.query(
      `INSERT INTO leads (org_id, name, email, phone_e164, status, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $6)
       ON CONFLICT (org_id, phone_e164) DO NOTHING`,
      [l.orgId, l.name, l.email, l.phoneE164, l.status, l.createdAt],
    );
  }
}

// Runs only when started from the command line (`npm run seed`), not when a test imports this file.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { db, withTransaction } = await import('../db.js');
  try {
    await withTransaction(seed);
    console.log(
      `seed: 2 organizations, ${Object.keys(SEED.users).length} users, ${SEED_LEADS.length} leads (existing rows kept)`,
    );
  } finally {
    await db.end();
  }
}
