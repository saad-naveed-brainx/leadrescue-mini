import { Router } from 'express';
import { z } from 'zod';
import { authOf, requireAuth, requirePermission } from '../../auth/middleware.js';
import type { Pool } from '../../db/pool.js';
import { listAuditEvents } from './repo.js';

const AuditQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Continue after this event id (from the previous page's `nextBefore`).
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});

export function auditRouter(pool: Pool): Router {
  const router = Router();
  router.get(
    '/audit-events',
    requireAuth(pool),
    requirePermission('audit:read'),
    async (req, res) => {
      const query = AuditQuery.parse(req.query);
      res.json(
        await listAuditEvents(pool, authOf(req).orgId, {
          limit: query.limit,
          beforeId: query.before,
        }),
      );
    },
  );
  return router;
}
