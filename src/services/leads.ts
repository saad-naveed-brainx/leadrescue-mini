import { db } from '../db.js';
import { AppError, notFound } from '../middleware/errors.js';
import {
  type LeadCreateInput,
  type LeadListQuery,
  type LeadUpdateInput,
  isUuid,
} from '../validation.js';

// Every query here filters by tenant_id. That is the wall between companies: a lead id from
// another company simply matches no row, so the caller gets "not found", as if it didn't exist.

// conversationId: the lead's SMS conversation, or null if they have never texted. Same company only.
const COLUMNS = `id, name, phone, email, status, notes, created_at AS "createdAt", updated_at AS "updatedAt",
  (SELECT c.id FROM conversations c
    WHERE c.tenant_id = leads.tenant_id AND c.lead_id = leads.id) AS "conversationId"`;

export interface Lead {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  conversationId: string | null;
}

// ─────────────────────────── the list, one page at a time ───────────────────────────
//
// Keyset paging: a page ends with some lead; the next page is "the leads after that one" in the
// order (created_at, id), newest first. The cursor is just that last lead's created_at and id.
// Unlike page numbers (OFFSET), the database never reads and skips earlier rows, so page 500 is
// as fast as page 1, and a lead added meanwhile doesn't shift what the next page shows.

interface Cursor {
  /** created_at exactly as PostgreSQL prints it (microseconds; a JS Date would lose them). */
  time: string;
  id: string;
}

/** The cursor is sent to the client as an opaque string. */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof c.time === 'string' && typeof c.id === 'string' && isUuid(c.id)) {
      return { time: c.time, id: c.id };
    }
  } catch {
    // fall through to the error below
  }
  throw new AppError(400, 'INVALID_CURSOR', 'Invalid page cursor');
}

export async function listLeads(
  tenantId: string,
  query: LeadListQuery,
): Promise<{ leads: Lead[]; nextCursor: string | null }> {
  // Build "WHERE ..." from the filters that were sent. Values always go in as $1, $2, ...
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1'];
  if (query.status) {
    params.push(query.status);
    where.push(`status = $${params.length}`);
  }
  if (query.cursor) {
    const after = decodeCursor(query.cursor);
    params.push(after.time, after.id);
    // "Older than the last lead of the previous page", comparing (created_at, id) as a pair.
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  // Ask for one more row than the page size: if it exists, there is a next page.
  params.push(query.limit + 1);

  const { rows } = await db.query<Lead & { cursorTime: string }>(
    `SELECT ${COLUMNS}, created_at::text AS "cursorTime"
       FROM leads
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const hasMore = rows.length > query.limit;
  return {
    leads: page.map(({ cursorTime: _cursorTime, ...lead }) => lead),
    nextCursor: hasMore && last ? encodeCursor({ time: last.cursorTime, id: last.id }) : null,
  };
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
