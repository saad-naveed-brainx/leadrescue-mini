import { describe, expect, it } from 'vitest';
import {
  computeTwilioSignature,
  isValidTwilioSignature,
} from '../src/modules/webhooks/twilioSignature.js';

const TOKEN = 'test-auth-token-123456';
const URL = 'https://api.leadrescue.test/webhooks/twilio/inbound';
const PARAMS = { MessageSid: 'SM0123', From: '+16465550110', To: '+12125550100', Body: 'Hi there' };

describe('Twilio signature check', () => {
  const good = computeTwilioSignature(TOKEN, URL, PARAMS);

  it('accepts the signature Twilio would send', () => {
    expect(isValidTwilioSignature(TOKEN, URL, PARAMS, good)).toBe(true);
  });

  it('does not depend on the order parameters arrive in', () => {
    const reordered = {
      Body: 'Hi there',
      To: '+12125550100',
      From: '+16465550110',
      MessageSid: 'SM0123',
    };
    expect(isValidTwilioSignature(TOKEN, URL, reordered, good)).toBe(true);
  });

  it('rejects a changed parameter, an added parameter, a different URL or a different token', () => {
    expect(isValidTwilioSignature(TOKEN, URL, { ...PARAMS, Body: 'Hi there!' }, good)).toBe(false);
    expect(isValidTwilioSignature(TOKEN, URL, { ...PARAMS, Extra: 'x' }, good)).toBe(false);
    expect(isValidTwilioSignature(TOKEN, `${URL}?x=1`, PARAMS, good)).toBe(false);
    expect(isValidTwilioSignature('another-token-000000', URL, PARAMS, good)).toBe(false);
  });

  it('rejects a missing or malformed signature', () => {
    expect(isValidTwilioSignature(TOKEN, URL, PARAMS, undefined)).toBe(false);
    expect(isValidTwilioSignature(TOKEN, URL, PARAMS, '')).toBe(false);
    expect(isValidTwilioSignature(TOKEN, URL, PARAMS, 'short')).toBe(false);
  });
});
