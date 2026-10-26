import { Router } from 'express';
import { z } from 'zod';
import { authOf, requireAuth, requirePermission } from '../middleware/auth.js';
import { listAuditEvents } from '../services/audit.js';

export const auditRouter = Router();

const AuditQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Continue after this event id (from the previous page's `nextBefore`).
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});

auditRouter.get('/audit-events', requireAuth, requirePermission('audit:read'), async (req, res) => {
  const query = AuditQuery.parse(req.query);
  res.json(
    await listAuditEvents(authOf(req).orgId, { limit: query.limit, beforeId: query.before }),
  );
});
