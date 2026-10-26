import type { LeadDto } from '@lr/shared';
import type { Queryable } from '../../db/queryable.js';

export interface ConversationDto {
  id: string;
  channel: 'sms';
  mode: 'auto' | 'manual';
  modeChangedAt: string | null;
  lastMessageAt: string | null;
}

export interface MessageDto {
  id: string;
  direction: 'inbound' | 'outbound';
  author: 'lead' | 'ai' | 'human' | 'system';
  body: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
}

export interface LeadConversationDto {
  conversation: ConversationDto | null;
  messages: MessageDto[];
  /** True while the lead's phone has an active STOP for this organization. */
  optedOut: boolean;
}

/** The lead's SMS conversation and its messages, oldest first. The lead must already be org-checked. */
export async function getLeadConversation(
  db: Queryable,
  orgId: string,
  lead: LeadDto,
  messageLimit = 200,
): Promise<LeadConversationDto> {
  const conv = await db.query<ConversationDto>(
    `SELECT id, channel, mode, mode_changed_at AS "modeChangedAt", last_message_at AS "lastMessageAt"
       FROM conversations WHERE org_id = $1 AND lead_id = $2 AND channel = 'sms'`,
    [orgId, lead.id],
  );
  const conversation = conv.rows[0] ?? null;

  const messages = conversation
    ? (
        await db.query<MessageDto>(
          `SELECT * FROM (
             SELECT id, direction, author, body, status, created_at AS "createdAt", sent_at AS "sentAt"
               FROM messages WHERE org_id = $1 AND conversation_id = $2
              ORDER BY created_at DESC LIMIT $3) latest
           ORDER BY "createdAt"`,
          [orgId, conversation.id, messageLimit],
        )
      ).rows
    : [];

  const optOut = lead.phone
    ? await db.query(
        `SELECT 1 FROM opt_outs
          WHERE org_id = $1 AND phone_e164 = $2 AND channel = 'sms' AND revoked_at IS NULL`,
        [orgId, lead.phone],
      )
    : { rowCount: 0 };

  return { conversation, messages, optedOut: (optOut.rowCount ?? 0) > 0 };
}
