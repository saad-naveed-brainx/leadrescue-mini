import { LeadCreateInput, LeadListQuery, LeadUpdateInput } from '@lr/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authOf, requireAuth, requirePermission } from '../middleware/auth.js';
import { AppError, notFound } from '../middleware/errors.js';
import { getLeadConversation } from '../services/conversations.js';
import * as leads from '../services/leads.js';

export const leadsRouter = Router();

// Every /leads route needs a signed-in user.
leadsRouter.use('/leads', requireAuth);

// A malformed id can't belong to the caller, so it gets the same 404 as another business's id.
function leadId(raw: unknown): string {
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) throw notFound('Lead');
  return parsed.data;
}

leadsRouter.get('/leads', requirePermission('leads:read'), async (req, res) => {
  const query = LeadListQuery.parse(req.query);
  const after = query.cursor ? leads.decodeCursor(query.cursor) : null;
  if (query.cursor && !after) throw new AppError(400, 'INVALID_CURSOR', 'Invalid page cursor');
  res.json(
    await leads.listLeads(authOf(req).orgId, {
      q: query.q,
      status: query.status,
      after,
      limit: query.limit,
    }),
  );
});

leadsRouter.post('/leads', requirePermission('leads:write'), async (req, res) => {
  const input = LeadCreateInput.parse(req.body);
  res.status(201).json(await leads.createLead(authOf(req), input, req.requestId));
});

leadsRouter.get('/leads/:id', requirePermission('leads:read'), async (req, res) => {
  const lead = await leads.findLead(authOf(req).orgId, leadId(req.params.id));
  if (!lead) throw notFound('Lead');
  res.json(lead);
});

leadsRouter.patch('/leads/:id', requirePermission('leads:write'), async (req, res) => {
  const input = LeadUpdateInput.parse(req.body);
  res.json(await leads.updateLead(authOf(req), leadId(req.params.id), input, req.requestId));
});

leadsRouter.delete('/leads/:id', requirePermission('leads:delete'), async (req, res) => {
  await leads.deleteLead(authOf(req), leadId(req.params.id), req.requestId);
  res.status(204).end();
});

leadsRouter.get('/leads/:id/conversation', requirePermission('leads:read'), async (req, res) => {
  const orgId = authOf(req).orgId;
  const lead = await leads.findLead(orgId, leadId(req.params.id));
  if (!lead) throw notFound('Lead');
  res.json(await getLeadConversation(orgId, lead));
});
