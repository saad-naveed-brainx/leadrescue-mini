import { db } from '../db.js';
import { AppError, notFound } from '../middleware/errors.js';
import type { LeadCreateInput, LeadUpdateInput } from '../validation.js';

// Every query here filters by tenant_id. That is the wall between companies: a lead id from
// another company simply matches no row, so the caller gets "not found", as if it didn't exist.

const COLUMNS = `id, name, phone, email, status, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;

export interface Lead {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listLeads(tenantId: string): Promise<Lead[]> {
  const { rows } = await db.query<Lead>(
    `SELECT ${COLUMNS} FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
    [tenantId],
  );
  return rows;
}

export async function findLead(tenantId: string, id: string): Promise<Lead | null> {
  const { rows } = await db.query<Lead>(
    `SELECT ${COLUMNS} FROM leads WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

export async function createLead(tenantId: string, input: LeadCreateInput): Promise<Lead> {
  try {
    const { rows } = await db.query<Lead>(
      `INSERT INTO leads (tenant_id, name, phone, email, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        tenantId,
        input.name,
        input.phone,
        input.email ?? null,
        input.status ?? 'new',
        input.notes ?? null,
      ],
    );
    return rows[0]!;
  } catch (err) {
    // 23505 = unique rule broken: this company already has a lead with this phone.
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(409, 'LEAD_EXISTS', 'A lead with this phone number already exists');
    }
    throw err;
  }
}

/** Changes status and/or notes. Only fields that were sent change (COALESCE keeps the rest). */
export async function updateLead(
  tenantId: string,
  id: string,
  input: LeadUpdateInput,
): Promise<Lead> {
  const { rows } = await db.query<Lead>(
    `UPDATE leads
        SET status = COALESCE($3::text, status),
            notes = CASE WHEN $4::boolean THEN $5::text ELSE notes END,
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${COLUMNS}`,
    [tenantId, id, input.status ?? null, input.notes !== undefined, input.notes ?? null],
  );
  if (!rows[0]) throw notFound('Lead');
  return rows[0];
}
