-- 0003_send_status: record each AI reply's progress, so a crash mid-send can never send it twice.
--
-- An AI reply is saved as 'sending' BEFORE it goes to the SMS provider, and set to 'sent' (with
-- the provider's message id) after. If the worker crashes in between, the retry finds the
-- 'sending' row and asks the provider whether it went out, instead of sending again.

ALTER TABLE messages
  ADD COLUMN send_status text CHECK (send_status IN ('sending', 'sent', 'cancelled')),
  ADD COLUMN sent_at timestamptz;

-- Replies saved before this migration were sent.
UPDATE messages SET send_status = 'sent', sent_at = created_at WHERE direction = 'outbound';

-- Outgoing messages always have a send status; incoming ones never do.
ALTER TABLE messages
  ADD CONSTRAINT messages_outbound_has_send_status CHECK ((direction = 'outbound') = (send_status IS NOT NULL));

-- MOCK ONLY: plays the part of the SMS provider's own record of what it sent (Twilio keeps one
-- too). It lives in the database so it survives a worker crash, which lets the retry ask
-- "did you already send this?". client_ref is our reply's message id.
CREATE TABLE mock_sms_sent (
  sid        text PRIMARY KEY,
  client_ref uuid NOT NULL,
  to_number  text NOT NULL,
  from_number text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Deliberately NOT unique: a real provider sends whatever it is given, twice if asked twice.
-- Tests count rows here to prove we never ask twice.
CREATE INDEX mock_sms_sent_client_ref_idx ON mock_sms_sent (client_ref);
