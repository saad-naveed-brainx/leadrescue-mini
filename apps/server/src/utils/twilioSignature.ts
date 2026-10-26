import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookParams = Record<string, string | string[]>;

/**
 * Twilio's request signature (X-Twilio-Signature) for a form-encoded POST: the full URL Twilio
 * called, followed by every POST parameter as name+value with names sorted, HMAC-SHA1'd with the
 * account's auth token, then base64. A repeated parameter contributes each of its values in order.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: WebhookParams,
): string {
  let data = url;
  for (const name of Object.keys(params).sort()) {
    const value = params[name]!;
    for (const v of Array.isArray(value) ? value : [value]) data += name + v;
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** True only if `signature` is exactly what Twilio would send. Constant-time comparison. */
export function isValidTwilioSignature(
  authToken: string,
  url: string,
  params: WebhookParams,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
