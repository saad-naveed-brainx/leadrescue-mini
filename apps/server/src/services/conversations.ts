import type { ConversationMode, LeadDto } from '@lr/shared';
import { type DbClient, db, withTransaction } from '../db.js';
import type { AuthContext } from '../middleware/auth.js';
import { AppError, notFound } from '../middleware/errors.js';
import { recordAudit } from './audit.js';
import { cancelPendingJobs } from './jobs.js';

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

/**
 * The per-conversation lock (PLAN.md §5.4). Everything that decides whether an automatic message
 * may go out takes it: sending, the Auto/Manual switch, STOP handling and closing a lead. While one
 * of them holds it, the others wait, so none can change the answer halfway through.
 * Released automatically when the transaction ends.
 */
export async function lockConversation(tx: DbClient, conversationId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_KEY})`, [conversationId]);
}

/** Turns a conversation id ($1) into the number Postgres locks on. Shared by both lock styles, so
 *  the send gate and STOP / Manual / closing really wait for each other. */
export const CONVERSATION_LOCK_KEY = `hashtextextended('conv:' || $1::text, 0)`;

export interface AutomationState {
  businessName: string;
  mode: 'auto' | 'manual';
  leadStatus: string;
  optedOut: boolean;
}

/** What a job needs to know before doing anything automatic in this conversation. */
export async function loadForAutomation(
  orgId: string,
  conversationId: string,
): Promise<AutomationState | null> {
  const { rows } = await db.query<AutomationState>(
    `SELECT o.name AS "businessName", c.mode, l.status AS "leadStatus",
            EXISTS (SELECT 1 FROM opt_outs x
                     WHERE x.org_id = c.org_id AND x.phone_e164 = l.phone_e164
                       AND x.channel = 'sms' AND x.revoked_at IS NULL) AS "optedOut"
       FROM conversations c
       JOIN leads l ON l.org_id = c.org_id AND l.id = c.lead_id
       JOIN organizations o ON o.id = c.org_id
      WHERE c.org_id = $1 AND c.id = $2`,
    [orgId, conversationId],
  );
  return rows[0] ?? null;
}

/** Why a job should not go ahead (STOP, Manual mode, closed lead), or null if it may. */
export function reasonToSkip(
  state: Pick<AutomationState, 'mode' | 'leadStatus' | 'optedOut'>,
): string | null {
  if (state.optedOut) return 'opted_out';
  if (state.mode !== 'auto') return 'manual_mode';
  if (state.leadStatus === 'closed') return 'lead_closed';
  return null;
}

/**
 * Staff switch a conversation between Auto (AI replies) and Manual (a person has taken over).
 *
 * It takes the conversation lock first, so if the AI is sending a reply at this very moment, the
 * switch waits until that text has gone out. From the moment it commits, the send gate sees
 * 'manual' and sends nothing. mode_changed_at uses clock_timestamp() (the time we got the lock),
 * not now() (the time the transaction started), so the history always shows the switch after
 * the last automatic text.
 */
export async function setConversationMode(
  auth: AuthContext,
  conversationId: string,
  mode: ConversationMode,
  requestId: string,
): Promise<ConversationDto> {
  try {
    return await withTransaction(async (tx) => {
      // Don't keep a staff member waiting forever behind a stuck send.
      await tx.query(`SET LOCAL lock_timeout = '5s'`);
      await lockConversation(tx, conversationId);

      const found = await tx.query<{ mode: ConversationMode }>(
        'SELECT mode FROM conversations WHERE org_id = $1 AND id = $2',
        [auth.orgId, conversationId],
      );
      if (!found.rows[0]) throw notFound('Conversation');
      const before = found.rows[0].mode;

      if (before !== mode) {
        await tx.query(
          `UPDATE conversations
              SET mode = $3, mode_changed_at = clock_timestamp(), mode_changed_by = $4
            WHERE org_id = $1 AND id = $2`,
          [auth.orgId, conversationId, mode, auth.userId],
        );
        if (mode === 'manual') {
          await cancelPendingJobs(tx, auth.orgId, conversationId, 'manual_mode');
        }
        await recordAudit(tx, {
          orgId: auth.orgId,
          actorType: 'user',
          actorUserId: auth.userId,
          action: 'conversation.mode_changed',
          targetType: 'conversation',
          targetId: conversationId,
          metadata: { from: before, to: mode },
          requestId,
        });
      }

      const { rows } = await tx.query<ConversationDto>(
        `SELECT id, channel, mode, mode_changed_at AS "modeChangedAt", last_message_at AS "lastMessageAt"
           FROM conversations WHERE org_id = $1 AND id = $2`,
        [auth.orgId, conversationId],
      );
      return rows[0]!;
    });
  } catch (err) {
    // 55P03 = Postgres gave up waiting for the lock (the 5 s above).
    if ((err as { code?: string }).code === '55P03') {
      throw new AppError(
        503,
        'CONVERSATION_BUSY',
        'A message is being sent; try again in a moment',
      );
    }
    throw err;
  }
}
