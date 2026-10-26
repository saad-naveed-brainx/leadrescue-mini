import type { LeadCreateInput, LeadDto, LeadStatus, LeadUpdateInput } from '@lr/shared';
import { db, withTransaction } from '../db.js';
import type { AuthContext } from '../middleware/auth.js';
import { AppError, notFound } from '../middleware/errors.js';
import { recordAudit } from './audit.js';

// Every query here filters by org_id. That is the wall between businesses: a lead id from another
// business simply matches no row, so the caller gets "not found".

const COLUMNS = `id, name, email, phone_e164 AS phone, status, source, notes,
                 created_at AS "createdAt", updated_at AS "updatedAt"`;

type LeadRow = Omit<LeadDto, 'createdAt' | 'updatedAt'> & { createdAt: Date; updatedAt: Date };

function toDto(row: LeadRow): LeadDto {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

// ─────────────────────────────── reading ───────────────────────────────

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

export async function listLeads(orgId: string, f: ListFilter) {
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

export async function findLead(orgId: string, id: string): Promise<LeadDto | null> {
  const { rows } = await db.query<LeadRow>(
    `SELECT ${COLUMNS} FROM leads WHERE org_id = $1 AND id = $2`,
    [orgId, id],
  );
  return rows[0] ? toDto(rows[0]) : null;
}

// ─────────────────────────────── changing ───────────────────────────────

const PG_UNIQUE_VIOLATION = '23505';

function isDuplicatePhone(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === PG_UNIQUE_VIOLATION && e.constraint === 'leads_org_id_phone_e164_key';
}
const duplicatePhone = () =>
  new AppError(
    409,
    'LEAD_PHONE_EXISTS',
    'Another lead in your organization already has this phone number',
  );

export async function createLead(
  auth: AuthContext,
  input: LeadCreateInput,
  requestId: string,
): Promise<LeadDto> {
  try {
    return await withTransaction(async (tx) => {
      const { rows } = await tx.query<LeadRow>(
        `INSERT INTO leads (org_id, name, email, phone_e164, notes, status, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
         RETURNING ${COLUMNS}`,
        [
          auth.orgId,
          input.name,
          input.email ?? null,
          input.phone ?? null,
          input.notes ?? null,
          input.status ?? 'new',
          auth.userId,
        ],
      );
      const lead = toDto(rows[0]!);
      await recordAudit(tx, {
        orgId: auth.orgId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'lead.created',
        targetType: 'lead',
        targetId: lead.id,
        requestId,
      });
      return lead;
    });
  } catch (err) {
    if (isDuplicatePhone(err)) throw duplicatePhone();
    throw err;
  }
}

// API field name → database column.
const COLUMN_FOR: Record<keyof LeadUpdateInput, string> = {
  name: 'name',
  email: 'email',
  phone: 'phone_e164',
  notes: 'notes',
  status: 'status',
};

export async function updateLead(
  auth: AuthContext,
  id: string,
  input: LeadUpdateInput,
  requestId: string,
): Promise<LeadDto> {
  try {
    return await withTransaction(async (tx) => {
      // FOR UPDATE locks the row until we're done, so two edits can't overwrite each other.
      const found = await tx.query<LeadRow>(
        `SELECT ${COLUMNS} FROM leads WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [auth.orgId, id],
      );
      if (!found.rows[0]) throw notFound('Lead');
      const before = toDto(found.rows[0]);

      const email = input.email === undefined ? before.email : input.email;
      const phone = input.phone === undefined ? before.phone : input.phone;
      if (!email && !phone) {
        throw new AppError(400, 'VALIDATION_FAILED', 'A lead needs an email or a phone number', [
          { path: 'email', message: 'Enter an email or a phone number' },
        ]);
      }

      // Build "SET name = $3, status = $4, ..." from the fields that were sent.
      const params: unknown[] = [auth.orgId, id];
      const sets = ['updated_at = now()'];
      for (const [field, value] of Object.entries(input) as [keyof LeadUpdateInput, unknown][]) {
        if (value === undefined) continue;
        params.push(value);
        sets.push(`${COLUMN_FOR[field]} = $${params.length}`);
      }
      const updated = await tx.query<LeadRow>(
        `UPDATE leads SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
        params,
      );
      const lead = toDto(updated.rows[0]!);

      const changed = (Object.keys(input) as (keyof LeadUpdateInput)[]).filter(
        (k) => input[k] !== undefined && input[k] !== before[k],
      );
      await recordAudit(tx, {
        orgId: auth.orgId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: before.status !== lead.status ? 'lead.status_changed' : 'lead.updated',
        targetType: 'lead',
        targetId: id,
        // Field names only, not values: audit history must not become a copy of customer data.
        metadata: {
          changed,
          ...(before.status !== lead.status && { from: before.status, to: lead.status }),
        },
        requestId,
      });
      return lead;
    });
  } catch (err) {
    if (isDuplicatePhone(err)) throw duplicatePhone();
    throw err;
  }
}

export async function deleteLead(auth: AuthContext, id: string, requestId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const { rowCount } = await tx.query('DELETE FROM leads WHERE org_id = $1 AND id = $2', [
      auth.orgId,
      id,
    ]);
    if (rowCount !== 1) throw notFound('Lead');
    await recordAudit(tx, {
      orgId: auth.orgId,
      actorType: 'user',
      actorUserId: auth.userId,
      action: 'lead.deleted',
      targetType: 'lead',
      targetId: id,
      requestId,
    });
  });
}
