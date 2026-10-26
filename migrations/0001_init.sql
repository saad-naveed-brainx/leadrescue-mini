-- 0001_init: the whole schema.
--
-- Keeping companies (tenants) apart:
--   * Every company-owned table has tenant_id NOT NULL.
--   * Child tables point at their parent with (tenant_id, parent_id), so the database itself refuses
--     a message or conversation that points at another company's lead or conversation.
--   * Phone numbers are stored in one format (E.164: '+' then 8-15 digits).

CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  -- The number customers text. An incoming SMS's "toNumber" picks exactly one company.
  phone_number text NOT NULL UNIQUE CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- The demo login sends this in the X-Demo-User header.
  email      text NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%'),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Empty for a lead created by an incoming SMS until someone names them.
  name       text CHECK (name IS NULL OR length(trim(name)) > 0),
  phone      text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email      text CHECK (email IS NULL OR (email = lower(email) AND email LIKE '%_@_%')),
  status     text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'closed')),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Lets child tables reference (tenant_id, id).
  UNIQUE (tenant_id, id),
  -- One lead per phone per company: an incoming SMS finds its lead by this. Two companies may
  -- each have a lead with the same phone.
  UNIQUE (tenant_id, phone)
);
CREATE INDEX leads_tenant_created_idx ON leads (tenant_id, created_at DESC);

CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  lead_id    uuid NOT NULL,
  -- AI = the AI answers; MANUAL = a person has taken over and the AI stays quiet.
  mode       text NOT NULL DEFAULT 'AI' CHECK (mode IN ('AI', 'MANUAL')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- One SMS conversation per lead.
  UNIQUE (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  conversation_id     uuid NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author              text NOT NULL CHECK (author IN ('customer', 'ai')),
  body                text NOT NULL,
  -- Twilio's messageSid of an incoming SMS. UNIQUE is what makes a repeated delivery create nothing:
  -- the second insert of the same messageSid is refused by the database, even if both arrive at once.
  provider_message_id text UNIQUE,
  -- For an AI reply: the customer message it answers. UNIQUE means one AI reply per customer
  -- message, ever, however many times the AI step runs.
  reply_to_message_id uuid UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reply_to_message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE,
  -- Incoming messages come from the customer and carry a messageSid; outgoing ones are from the AI.
  CHECK ((direction = 'inbound') = (author = 'customer')),
  CHECK (direction = 'outbound' OR provider_message_id IS NOT NULL)
);
CREATE INDEX messages_conversation_idx ON messages (tenant_id, conversation_id, created_at);
