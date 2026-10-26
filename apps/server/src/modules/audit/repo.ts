import type { Queryable } from '../../db/queryable.js';
import { currentRequestId } from '../../http/requestContext.js';

export interface AuditEvent {
  orgId: string | null;
  actorType: 'user' | 'platform_admin' | 'system' | 'webhook';
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Appends one audit event. Pass the transaction's client so the event commits or rolls back
 * together with the change it describes.
 */
export async function recordAudit(db: Queryable, e: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (org_id, actor_type, actor_user_id, action, target_type, target_id, metadata, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.orgId,
      e.actorType,
      e.actorUserId ?? null,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.metadata ?? {},
      currentRequestId() ?? null,
    ],
  );
}

export interface AuditEventDto {
  id: string;
  actorType: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  correlationId: string | null;
  createdAt: string;
}

/**
 * Newest first. `beforeId` continues from the last event of the previous page; ids only ever grow,
 * so this pages through the whole history without gaps or repeats.
 */
export async function listAuditEvents(
  db: Queryable,
  orgId: string,
  { limit, beforeId }: { limit: number; beforeId?: string | undefined },
) {
  const { rows } = await db.query<AuditEventDto>(
    `SELECT id::text, actor_type AS "actorType", actor_user_id AS "actorUserId", action,
            target_type AS "targetType", target_id AS "targetId", metadata,
            correlation_id AS "correlationId", created_at AS "createdAt"
       FROM audit_events
      WHERE org_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC
      LIMIT $3`,
    [orgId, beforeId ?? null, limit + 1],
  );
  const items = rows.slice(0, limit);
  return {
    items,
    nextBefore: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null,
  };
}
