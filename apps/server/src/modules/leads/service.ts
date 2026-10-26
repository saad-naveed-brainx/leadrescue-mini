import type { LeadCreateInput, LeadDto, LeadUpdateInput } from '@lr/shared';
import type { AuthContext } from '../../auth/middleware.js';
import { type Pool, withTx } from '../../db/pool.js';
import { AppError, notFound } from '../../http/errors.js';
import { recordAudit } from '../audit/repo.js';
import * as repo from './repo.js';

const PG_UNIQUE_VIOLATION = '23505';

function isDuplicatePhone(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e.code === PG_UNIQUE_VIOLATION && e.constraint === 'leads_org_id_phone_e164_key';
}
const duplicatePhone = () =>
  new AppError(
    409,
    'LEAD_PHONE_EXISTS',
    'Another lead in your organization already has this phone number',
  );

export async function createLead(
  pool: Pool,
  auth: AuthContext,
  input: LeadCreateInput,
): Promise<LeadDto> {
  try {
    return await withTx(pool, async (tx) => {
      const lead = await repo.insertLead(tx, auth.orgId, {
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        notes: input.notes ?? null,
        status: input.status ?? 'new',
        createdBy: auth.userId,
      });
      await recordAudit(tx, {
        orgId: auth.orgId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: 'lead.created',
        targetType: 'lead',
        targetId: lead.id,
      });
      return lead;
    });
  } catch (err) {
    if (isDuplicatePhone(err)) throw duplicatePhone();
    throw err;
  }
}

export async function updateLead(
  pool: Pool,
  auth: AuthContext,
  id: string,
  input: LeadUpdateInput,
): Promise<LeadDto> {
  try {
    return await withTx(pool, async (tx) => {
      const before = await repo.findLeadForUpdate(tx, auth.orgId, id);
      if (!before) throw notFound('Lead');

      const email = input.email === undefined ? before.email : input.email;
      const phone = input.phone === undefined ? before.phone : input.phone;
      if (!email && !phone) {
        throw new AppError(400, 'VALIDATION_FAILED', 'A lead needs an email or a phone number', [
          { path: 'email', message: 'Enter an email or a phone number' },
        ]);
      }

      const lead = (await repo.updateLead(tx, auth.orgId, id, input))!;
      const changed = (Object.keys(input) as (keyof LeadUpdateInput)[]).filter(
        (k) => input[k] !== undefined && input[k] !== before[k],
      );
      await recordAudit(tx, {
        orgId: auth.orgId,
        actorType: 'user',
        actorUserId: auth.userId,
        action: before.status !== lead.status ? 'lead.status_changed' : 'lead.updated',
        targetType: 'lead',
        targetId: id,
        // Field names only, not values: audit history must not become a copy of customer data.
        metadata: {
          changed,
          ...(before.status !== lead.status && { from: before.status, to: lead.status }),
        },
      });
      return lead;
    });
  } catch (err) {
    if (isDuplicatePhone(err)) throw duplicatePhone();
    throw err;
  }
}

export async function deleteLead(pool: Pool, auth: AuthContext, id: string): Promise<void> {
  await withTx(pool, async (tx) => {
    if (!(await repo.deleteLead(tx, auth.orgId, id))) throw notFound('Lead');
    await recordAudit(tx, {
      orgId: auth.orgId,
      actorType: 'user',
      actorUserId: auth.userId,
      action: 'lead.deleted',
      targetType: 'lead',
      targetId: id,
    });
  });
}
