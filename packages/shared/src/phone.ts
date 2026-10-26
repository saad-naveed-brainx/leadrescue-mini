import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Turns whatever a person or a provider typed ("(646) 555-0110", "+1 646 555 0110") into E.164
 * ("+16465550110"), the one format we store and match on. Numbers without a country code are read
 * as US numbers. Returns null for anything that isn't a valid phone number.
 */
export function normalizePhone(input: string, defaultCountry: 'US' = 'US'): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}
