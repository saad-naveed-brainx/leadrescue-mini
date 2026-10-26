import { type FormEvent, useState } from 'react';
import { DEMO_USERS, apiFetch } from './api';

/** What the webhook answers. */
export type InboundResult =
  | { result: 'duplicate' }
  | {
      result: 'saved';
      conversationId: string;
      aiReply: { sent: true } | { sent: false; reason: string };
    };

const newSid = () => `SM${crypto.randomUUID().replaceAll('-', '')}`;

// Plays the part of Twilio: posts a simulated incoming SMS to POST /webhooks/twilio/inbound.
// "Send again" re-sends the last message with the same messageSid, to show it is stored once.
export function SimulateSmsPanel({
  onSent,
}: {
  onSent: (toNumber: string, result: InboundResult) => void;
}) {
  const [toNumber, setToNumber] = useState(DEMO_USERS[0]!.companyNumber);
  const [fromNumber, setFromNumber] = useState('+16465550199');
  const [body, setBody] = useState('Hi, do you do weekend callouts?');
  const [lastSent, setLastSent] = useState<Record<string, string> | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(sms: Record<string, string>) {
    setError(null);
    try {
      // No X-Demo-User: the webhook isn't called by a user. The number texted picks the company.
      const result = await apiFetch<InboundResult>(null, '/webhooks/twilio/inbound', {
        method: 'POST',
        body: sms,
      });
      setLastSent(sms);
      setOutcome(describe(result));
      onSent(sms.toNumber!, result);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function sendNew(e: FormEvent) {
    e.preventDefault();
    void post({ messageSid: newSid(), toNumber, fromNumber, body });
  }

  return (
    <form className="card create-form" onSubmit={sendNew}>
      <h2>Simulate an incoming SMS (as Twilio)</h2>
      <label>
        To{' '}
        <select value={toNumber} onChange={(e) => setToNumber(e.target.value)}>
          {DEMO_USERS.map((u) => (
            <option key={u.companyNumber} value={u.companyNumber}>
              {u.label.replace(/.*\((.*)\)/, '$1')} {u.companyNumber}
            </option>
          ))}
        </select>
      </label>
      <input
        aria-label="From number"
        placeholder="From, e.g. +16465550199"
        value={fromNumber}
        onChange={(e) => setFromNumber(e.target.value)}
      />
      <input
        aria-label="Message"
        className="grow"
        placeholder="Message"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <button type="submit">Send SMS</button>
      <button
        type="button"
        disabled={!lastSent}
        title="Send the last message again with the same messageSid"
        onClick={() => lastSent && void post(lastSent)}
      >
        Send again (same messageSid)
      </button>
      {outcome && <p className="muted outcome">{outcome}</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function describe(result: InboundResult): string {
  if (result.result === 'duplicate') {
    return 'Duplicate: this messageSid was already stored. Nothing new saved, no AI reply.';
  }
  return result.aiReply.sent
    ? 'Saved. The AI replied.'
    : `Saved. No AI reply (${result.aiReply.reason === 'manual_mode' ? 'conversation is MANUAL' : result.aiReply.reason}).`;
}
