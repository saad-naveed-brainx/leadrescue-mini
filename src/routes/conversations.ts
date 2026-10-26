import { Router } from 'express';
import { currentUser, requireUser } from '../middleware/auth.js';
import { notFound } from '../middleware/errors.js';
import { getConversation, handoff } from '../services/conversations.js';
import { HandoffInput, isUuid } from '../validation.js';

export const conversationsRouter = Router();

conversationsRouter.use('/conversations', requireUser);

// The conversation and its messages, so you can see what was stored and what the AI sent.
conversationsRouter.get('/conversations/:id', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Conversation');
  res.json(await getConversation(currentUser(req).tenantId, req.params.id));
});

// A person takes over ({"mode": "MANUAL"}) or hands it back to the AI ({"mode": "AI"}).
conversationsRouter.post('/conversations/:id/handoff', async (req, res) => {
  if (!isUuid(req.params.id)) throw notFound('Conversation');
  const { mode } = HandoffInput.parse(req.body);
  res.json(await handoff(currentUser(req).tenantId, req.params.id, mode));
});
