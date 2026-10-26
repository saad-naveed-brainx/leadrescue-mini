/**
 * Plays the part of Twilio: posts a correctly signed inbound-SMS webhook to the running API.
 *
 *   npm run send-inbound -- --from "+16465550110" --body "Do you do weekend callouts?"
 *   npm run send-inbound -- --file docs/sample-payloads/inbound-stop.json
 *   npm run send-inbound -- --from "+16465550110" --body "hi" --sid SM00000000000000000000000000000001
 *     (send the same --sid twice to see deduplication)
 *
 * Defaults: --to is Acme Plumbing's seeded number, --sid is random, --url is PUBLIC_BASE_URL.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { SEED } from '../db/seed.js';
import { computeTwilioSignature } from '../modules/webhooks/twilioSignature.js';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    body: { type: 'string' },
    sid: { type: 'string' },
    url: { type: 'string' },
  },
});

const fromFile = values.file
  ? (JSON.parse(
      readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), values.file), 'utf8'),
    ) as Record<string, string>)
  : {};
const params: Record<string, string> = {
  AccountSid: 'AC00000000000000000000000000000000',
  NumMedia: '0',
  ...fromFile,
  ...(values.from && { From: values.from }),
  ...(values.to && { To: values.to }),
  ...(values.body !== undefined && { Body: values.body }),
  ...(values.sid && { MessageSid: values.sid }),
};
params.To ??= SEED.phoneNumbers.acme.e164;
params.MessageSid ??= `SM${randomBytes(16).toString('hex')}`;
if (!params.From) {
  console.error('missing --from (or a "From" in --file)');
  process.exit(1);
}

const url = `${values.url ?? config.PUBLIC_BASE_URL}/webhooks/twilio/inbound`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Twilio-Signature': computeTwilioSignature(config.TWILIO_AUTH_TOKEN, url, params),
  },
  body: new URLSearchParams(params),
});
console.log(
  `${res.status} ${params.MessageSid} ${params.From} -> ${params.To}: ${JSON.stringify(params.Body ?? '')}`,
);
console.log((await res.text()).slice(0, 300));
process.exit(res.ok ? 0 : 1);
