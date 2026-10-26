import { z } from 'zod';

/** auto = the AI replies; manual = a staff member has taken over and the AI stays quiet. */
export const ConversationMode = z.enum(['auto', 'manual']);
export type ConversationMode = z.infer<typeof ConversationMode>;

/** Body of PATCH /conversations/:id/mode. */
export const ConversationModeInput = z.strictObject({ mode: ConversationMode });
export type ConversationModeInput = z.infer<typeof ConversationModeInput>;
