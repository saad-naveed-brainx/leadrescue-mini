import { ConversationModeInput } from '@lr/shared';
import { Router } from 'express';
import { z } from 'zod';
import { authOf, requireAuth, requirePermission } from '../middleware/auth.js';
import { notFound } from '../middleware/errors.js';
import { setConversationMode } from '../services/conversations.js';

export const conversationsRouter = Router();

conversationsRouter.use('/conversations', requireAuth);

// Staff take over a conversation (manual) or hand it back to the AI (auto).
conversationsRouter.patch(
  '/conversations/:id/mode',
  requirePermission('conversations:mode'),
  async (req, res) => {
    // A malformed id can't belong to the caller: same 404 as another business's conversation.
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw notFound('Conversation');
    const { mode } = ConversationModeInput.parse(req.body);
    res.json(await setConversationMode(authOf(req), id.data, mode, req.requestId));
  },
);
