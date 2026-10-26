import type { LeadDto, LeadStatus } from '@lr/shared';
import type { Queryable } from '../../db/queryable.js';

// Every function takes orgId and puts it in the WHERE clause. That is the tenant boundary:
// a lead id from another organization simply matches no row.

const COLUMNS = `id, name, email, phone_e164 AS phone, status, source, notes,
                 created_at AS "createdAt", updated_at AS "updatedAt"`;

type LeadRow = Omit<LeadDto, 'createdAt' | 'updatedAt'> & { createdAt: Date; updatedAt: Date };

function toDto(row: LeadRow): LeadDto {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Opaque page position: the exact (created_at, id) of the last row, as Postgres printed it. */
interface Cursor {
  t: string;
  id: string;
}
export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    return typeof c.t === 'string' && typeof c.id === 'string' ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

// Search input is matched literally: % and _ must not act as wildcards.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export interface ListFilter {
  q?: string | undefined;
  status?: LeadStatus | undefined;
  after?: Cursor | null;
  limit: number;
}

export async function listLeads(db: Queryable, orgId: string, f: ListFilter) {
  const params: unknown[] = [orgId];
  const where = ['org_id = $1'];
  if (f.status) {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${escapeLike(f.q)}%`);
    // Same expression as the trigram index in 0001_init.sql, so the index can be used.
    where.push(
      `(coalesce(name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone_e164, '')) ILIKE $${params.length}`,
    );
  }
  if (f.after) {
    params.push(f.after.t, f.after.id);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  // One extra row tells us whether there is a next page without a separate count query.
  params.push(f.limit + 1);
  const { rows } = await db.query<LeadRow & { cursorTs: string }>(
    `SELECT ${COLUMNS}, created_at::text AS "cursorTs"
       FROM leads
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ cursorTs: _c, ...row }) => toDto(row)),
    nextCursor:
      rows.length > f.limit && last ? encodeCursor({ t: last.cursorTs, id: last.id }) : null,
  };
}

export async function findLead(db: Queryable, orgId: string, id: string): Promise<LeadDto | null> {
  const { rows } = await db.query<LeadRow>(
    `SELECT ${COLUMNS} FROM leads WHERE org_id = $1 AND id = $2`,
    [orgId, id],
  );
  return rows[0] ? toDto(rows[0]) : null;
}

/** Same as findLead, but locks the row until the transaction ends (for read-modify-write). */
export async function findLeadForUpdate(db: Queryable, orgId: string, id: string) {
  const { rows } = await db.query<LeadRow>(
    `SELECT ${COLUMNS} FROM leads WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, id],
  );
  return rows[0] ? toDto(rows[0]) : null;
}

export interface NewLead {
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: LeadStatus;
  createdBy: string;
}

export async function insertLead(db: Queryable, orgId: string, l: NewLead): Promise<LeadDto> {
  const { rows } = await db.query<LeadRow>(
    `INSERT INTO leads (org_id, name, email, phone_e164, notes, status, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
     RETURNING ${COLUMNS}`,
    [orgId, l.name, l.email, l.phone, l.notes, l.status, l.createdBy],
  );
  return toDto(rows[0]!);
}

export interface LeadChanges {
  name?: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  status?: LeadStatus;
}

const COLUMN_FOR: Record<keyof LeadChanges, string> = {
  name: 'name',
  email: 'email',
  phone: 'phone_e164',
  notes: 'notes',
  status: 'status',
};

export async function updateLead(db: Queryable, orgId: string, id: string, changes: LeadChanges) {
  const params: unknown[] = [orgId, id];
  const sets = ['updated_at = now()'];
  for (const [field, value] of Object.entries(changes) as [keyof LeadChanges, unknown][]) {
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${COLUMN_FOR[field]} = $${params.length}`);
  }
  const { rows } = await db.query<LeadRow>(
    `UPDATE leads SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ? toDto(rows[0]) : null;
}

export async function deleteLead(db: Queryable, orgId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM leads WHERE org_id = $1 AND id = $2', [
    orgId,
    id,
  ]);
  return rowCount === 1;
}
