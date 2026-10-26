import { z } from 'zod';
import { normalizePhone } from './phone.js';

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'closed'] as const;
export const LeadStatus = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof LeadStatus>;

const name = z.string().trim().min(1, 'Name is required').max(120, 'Name is too long');
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));
const phone = z
  .string()
  .trim()
  .max(32, 'Phone is too long')
  .transform((value, ctx) => {
    const e164 = normalizePhone(value);
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' });
      return z.NEVER;
    }
    return e164;
  });
const notes = z.string().trim().max(2000, 'Notes are too long');

// Forms send "" for an empty optional field; treat it as "not given".
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
// On edit, "" or null clears the field.
const clearable = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? null : v), schema.nullable().optional());

const needsContact = { message: 'Enter an email or a phone number', path: ['email'] };

/** Body of "create lead". `.strict()` rejects unknown fields, including any attempt to pass an org id. */
export const LeadCreateInput = z
  .strictObject({
    name,
    email: optional(email),
    phone: optional(phone),
    notes: optional(notes),
    status: LeadStatus.optional(),
  })
  .refine((l) => l.email || l.phone, needsContact);
export type LeadCreateInput = z.infer<typeof LeadCreateInput>;

/** Body of "edit lead": any subset of fields. Whether email-or-phone still holds is checked against the stored lead. */
export const LeadUpdateInput = z
  .strictObject({
    name: name.optional(),
    email: clearable(email),
    phone: clearable(phone),
    notes: clearable(notes),
    status: LeadStatus.optional(),
  })
  .refine((l) => Object.values(l).some((v) => v !== undefined), {
    message: 'Nothing to update',
  });
export type LeadUpdateInput = z.infer<typeof LeadUpdateInput>;

export const LeadListQuery = z.strictObject({
  q: optional(z.string().trim().max(100)),
  status: optional(LeadStatus),
  cursor: optional(z.string().max(200)),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type LeadListQuery = z.infer<typeof LeadListQuery>;

/** A lead as the API returns it. */
export interface LeadDto {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: LeadStatus;
  source: 'manual' | 'sms';
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadPage {
  items: LeadDto[];
  /** Pass back as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}
