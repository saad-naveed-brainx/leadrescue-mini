import { LeadCreateInput, LeadListQuery, LeadUpdateInput } from '@lr/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authOf, requireAuth, requirePermission } from '../../auth/middleware.js';
import type { Pool } from '../../db/pool.js';
import { AppError, notFound } from '../../http/errors.js';
import { getLeadConversation } from '../conversations/repo.js';
import * as repo from './repo.js';
import * as service from './service.js';

// A malformed id can't belong to the caller, so it gets the same 404 as another tenant's id.
function leadId(raw: unknown): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw notFound('Lead');
  return parsed.data;
}

export function leadsRouter(pool: Pool): Router {
  const router = Router();
  router.use('/leads', requireAuth(pool));

  router.get('/leads', requirePermission('leads:read'), async (req, res) => {
    const query = LeadListQuery.parse(req.query);
    const after = query.cursor ? repo.decodeCursor(query.cursor) : null;
    if (query.cursor && !after) throw new AppError(400, 'INVALID_CURSOR', 'Invalid page cursor');
    res.json(
      await repo.listLeads(pool, authOf(req).orgId, {
        q: query.q,
        status: query.status,
        after,
        limit: query.limit,
      }),
    );
  });

  router.post('/leads', requirePermission('leads:write'), async (req, res) => {
    const input = LeadCreateInput.parse(req.body);
    res.status(201).json(await service.createLead(pool, authOf(req), input));
  });

  router.get('/leads/:id', requirePermission('leads:read'), async (req, res) => {
    const lead = await repo.findLead(pool, authOf(req).orgId, leadId(req.params.id));
    if (!lead) throw notFound('Lead');
    res.json(lead);
  });

  router.patch('/leads/:id', requirePermission('leads:write'), async (req, res) => {
    const input = LeadUpdateInput.parse(req.body);
    res.json(await service.updateLead(pool, authOf(req), leadId(req.params.id), input));
  });

  router.delete('/leads/:id', requirePermission('leads:delete'), async (req, res) => {
    await service.deleteLead(pool, authOf(req), leadId(req.params.id));
    res.status(204).end();
  });

  router.get('/leads/:id/conversation', requirePermission('leads:read'), async (req, res) => {
    const orgId = authOf(req).orgId;
    const id = leadId(req.params.id);
    const lead = await repo.findLead(pool, orgId, id);
    if (!lead) throw notFound('Lead');
    res.json(await getLeadConversation(pool, orgId, lead));
  });

  return router;
}
