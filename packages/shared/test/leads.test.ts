import { describe, expect, it } from 'vitest';
import { LeadCreateInput, LeadListQuery, LeadUpdateInput, normalizePhone } from '../src/index.js';

describe('normalizePhone', () => {
  it('turns common US formats into E.164', () => {
    expect(normalizePhone('(646) 555-0110')).toBe('+16465550110');
    expect(normalizePhone('646.555.0110')).toBe('+16465550110');
    expect(normalizePhone(' +1 646 555 0110 ')).toBe('+16465550110');
  });

  it('keeps international numbers that carry a country code', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('rejects incomplete or impossible numbers', () => {
    expect(normalizePhone('555-0110')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
  });
});

describe('LeadCreateInput', () => {
  it('normalizes email and phone and drops empty optional fields', () => {
    const lead = LeadCreateInput.parse({
      name: '  Maria Lopez ',
      email: 'Maria@Example.TEST',
      phone: '(646) 555-0199',
      notes: '',
    });
    expect(lead).toEqual({
      name: 'Maria Lopez',
      email: 'maria@example.test',
      phone: '+16465550199',
    });
  });

  it('requires a name and either an email or a phone', () => {
    expect(LeadCreateInput.safeParse({ name: '', email: 'a@b.test' }).success).toBe(false);
    expect(LeadCreateInput.safeParse({ name: 'No Contact' }).success).toBe(false);
    expect(LeadCreateInput.safeParse({ name: 'Phone Only', phone: '6465550199' }).success).toBe(
      true,
    );
  });

  it('rejects bad formats with field-level messages', () => {
    const result = LeadCreateInput.safeParse({ name: 'X', email: 'not-an-email', phone: '123' });
    expect(result.success).toBe(false);
    const paths = result.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['email', 'phone']));
  });

  it('rejects unknown fields, so a client cannot choose the tenant', () => {
    const result = LeadCreateInput.safeParse({ name: 'X', email: 'x@y.test', orgId: 'other' });
    expect(result.success).toBe(false);
  });
});

describe('LeadUpdateInput', () => {
  it('treats an empty string as "clear this field"', () => {
    expect(LeadUpdateInput.parse({ email: '' })).toEqual({ email: null });
  });

  it('rejects an empty update', () => {
    expect(LeadUpdateInput.safeParse({}).success).toBe(false);
  });

  it('only accepts the four statuses', () => {
    expect(LeadUpdateInput.safeParse({ status: 'qualified' }).success).toBe(true);
    expect(LeadUpdateInput.safeParse({ status: 'won' }).success).toBe(false);
  });
});

describe('LeadListQuery', () => {
  it('defaults and bounds the page size', () => {
    expect(LeadListQuery.parse({}).limit).toBe(20);
    expect(LeadListQuery.safeParse({ limit: '500' }).success).toBe(false);
  });
});
