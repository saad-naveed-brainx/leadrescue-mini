import { withTransaction } from '../db.js';
import { notFound } from '../middleware/errors.js';
import type { InboundSms } from '../validation.js';

export type InboundResult =
  | { result: 'duplicate' }
  | { result: 'saved'; leadId: string; conversationId: string; messageId: string };

/**
 * Saves one incoming SMS: finds or creates the lead and its conversation, and stores the message.
 * All in one transaction, so either everything is saved or nothing is.
 *
 * Repeated delivery: messages.provider_message_id (the messageSid) is UNIQUE. If the same
 * messageSid arrives twice, even at the same moment, the database lets only one insert through.
 * The second waits for the first to finish, then finds the row already there and inserts nothing.
 */
export async function saveInboundSms(sms: InboundSms): Promise<InboundResult> {
  return withTransaction(async (tx) => {
    // 1. The number that was texted decides the company. Nothing else in the payload is trusted
    //    for this.
    const tenant = (
      await tx.query<{ id: string }>('SELECT id FROM tenants WHERE phone_number = $1', [
        sms.toNumber,
      ])
    ).rows[0];
    if (!tenant) throw notFound('Company for this number');

    // 2. Find the lead by phone within this company, or create it. ON CONFLICT DO NOTHING plus a
    //    second SELECT also works when two copies arrive at once: one creates it, the other finds it.
    await tx.query(
      `INSERT INTO leads (tenant_id, phone) VALUES ($1, $2) ON CONFLICT (tenant_id, phone) DO NOTHING`,
      [tenant.id, sms.fromNumber],
    );
    const leadId = (
      await tx.query<{ id: string }>('SELECT id FROM leads WHERE tenant_id = $1 AND phone = $2', [
        tenant.id,
        sms.fromNumber,
      ])
    ).rows[0]!.id;

    // 3. The same for the lead's conversation.
    await tx.query(
      `INSERT INTO conversations (tenant_id, lead_id) VALUES ($1, $2)
       ON CONFLICT (tenant_id, lead_id) DO NOTHING`,
      [tenant.id, leadId],
    );
    const conversationId = (
      await tx.query<{ id: string }>(
        'SELECT id FROM conversations WHERE tenant_id = $1 AND lead_id = $2',
        [tenant.id, leadId],
      )
    ).rows[0]!.id;

    // 4. The message itself. If this messageSid is already stored, nothing is inserted and
    //    RETURNING gives no row: it's a repeat delivery.
    const message = (
      await tx.query<{ id: string }>(
        `INSERT INTO messages (tenant_id, conversation_id, direction, author, body, provider_message_id)
         VALUES ($1, $2, 'inbound', 'customer', $3, $4)
         ON CONFLICT (provider_message_id) DO NOTHING
         RETURNING id`,
        [tenant.id, conversationId, sms.body, sms.messageSid],
      )
    ).rows[0];
    if (!message) return { result: 'duplicate' };

    return { result: 'saved', leadId, conversationId, messageId: message.id };
  });
}
