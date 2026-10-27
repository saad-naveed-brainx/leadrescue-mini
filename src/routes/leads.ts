import { Router } from 'express';
import { currentUser, requireUser } from '../middleware/auth.js';
import { notFound } from '../middleware/errors.js';
import * as leads from '../services/leads.js';
import { LeadCreateInput, LeadListQuery, LeadUpdateInput, isUuid } from '../validation.js';

export const leadsRouter = Router();

// Every /leads route needs a signed-in user; their company comes from requireUser.
leadsRouter.use('/leads', requireUser);

// ?status=new&limit=50&cursor=... → { leads, nextCursor }. Pass nextCursor back for the next page.
leadsRouter.get('/leads', async (req, res) => {
  const query = LeadListQuery.parse(req.query);
  res.json(await leads.listLeads(currentUser(req).tenantId, query));
});

leadsRouter.post('/leads', async (req, res) => {
  const input = LeadCreateInput.parse(req.body);
  res.status(201).json(await leads.createLead(currentUser(req).tenantId, input));
});

leadsRouter.get('/leads/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Lead');
  const lead = await leads.findLead(currentUser(req).tenantId, req.params.id);
  if (!lead) throw notFound('Lead');
  res.json(lead);
});

leadsRouter.patch('/leads/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Lead');
  const input = LeadUpdateInput.parse(req.body);
  res.json(await leads.updateLead(currentUser(req).tenantId, req.params.id, input));
});
