import { z } from 'zod';

// What each request body must look like. `strictObject` refuses unknown fields, so a caller can't
// slip in a tenantId (or anything else we didn't ask for).

/** E.164: '+', country code, number. 8 to 15 digits in all, e.g. +12125550100. */
export const Phone = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{7,14}$/, 'Use international format, e.g. +12125550100');

export const LeadStatus = z.enum(['new', 'contacted', 'qualified', 'closed']);
const notes = z.string().trim().max(2000, 'Notes are too long');

/** Body of POST /leads. */
export const LeadCreateInput = z.strictObject({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
  phone: Phone,
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).optional(),
  status: LeadStatus.optional(),
  notes: notes.optional(),
});
export type LeadCreateInput = z.infer<typeof LeadCreateInput>;

/** Body of PATCH /leads/:id: status, notes, or both. null clears the notes. */
export const LeadUpdateInput = z
  .strictObject({ status: LeadStatus.optional(), notes: notes.nullable().optional() })
  .refine((body) => body.status !== undefined || body.notes !== undefined, {
    message: 'Send status or notes',
  });
export type LeadUpdateInput = z.infer<typeof LeadUpdateInput>;

/** Query of GET /leads. Unknown query parameters (e.g. tenantId) are refused. */
export const LeadListQuery = z.strictObject({
  status: LeadStatus.optional(),
  /** Leads per page. */
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** From the previous page's nextCursor: continue after that lead. */
  cursor: z.string().max(200).optional(),
});
export type LeadListQuery = z.infer<typeof LeadListQuery>;

/** Body of POST /conversations/:id/handoff. */
export const HandoffInput = z.strictObject({ mode: z.enum(['AI', 'MANUAL']) });

/** Body of POST /webhooks/twilio/inbound: the simulated Twilio event. */
export const InboundSms = z.strictObject({
  messageSid: z.string().trim().min(1).max(64),
  toNumber: Phone,
  fromNumber: Phone,
  body: z.string().max(1600),
});
export type InboundSms = z.infer<typeof InboundSms>;

/** A malformed id can't belong to anyone, so it gets the same 404 as another company's id. */
export function isUuid(value: unknown): value is string {
  return z.uuid().safeParse(value).success;
}
