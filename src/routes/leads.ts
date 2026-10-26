import { Router } from 'express';
import { currentUser, requireUser } from '../middleware/auth.js';
import { notFound } from '../middleware/errors.js';
import * as leads from '../services/leads.js';
import { LeadCreateInput, LeadUpdateInput, isUuid } from '../validation.js';

export const leadsRouter = Router();

// Every /leads route needs a signed-in user; their company comes from requireUser.
leadsRouter.use('/leads', requireUser);

leadsRouter.get('/leads', async (req, res) => {
  res.json({ leads: await leads.listLeads(currentUser(req).tenantId) });
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
