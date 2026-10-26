-- 0001_init: the complete initial schema.
--
-- Tenant-safety rules used throughout:
--   * Every tenant-owned table has org_id NOT NULL and UNIQUE (org_id, id).
--   * Child rows reference parents through composite foreign keys (org_id, parent_id), so the
--     database itself rejects a row that points at another tenant's parent.
--   * Phones are E.164 ('+' then up to 15 digits); emails are stored lower-cased.
--   * Plain UNIQUE constraints treat NULLs as distinct, so nullable unique columns still work
--     with ON CONFLICT.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────────── tenants and people ─────────────────────────────

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%'),
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  -- Platform staff, not a tenant role. Grants nothing by itself: admin routes check it explicitly.
  is_platform_admin boolean NOT NULL DEFAULT false,
  suspended_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'manager', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX organization_memberships_user_idx ON organization_memberships (user_id);

-- The numbers customers text. Globally unique: an inbound message's "To" picks exactly one tenant.
CREATE TABLE phone_numbers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  e164       text NOT NULL UNIQUE CHECK (e164 ~ '^\+[1-9][0-9]{7,14}$'),
  label      text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

-- ───────────────────────────────── leads ─────────────────────────────────

CREATE TABLE leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- NULL for leads created by an inbound SMS until a staff member names them.
  name       text CHECK (name IS NULL OR length(trim(name)) > 0),
  email      text CHECK (email IS NULL OR (email = lower(email) AND email LIKE '%_@_%')),
  phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status     text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'closed')),
  source     text NOT NULL CHECK (source IN ('manual', 'sms')),
  notes      text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  -- One lead per phone per tenant: inbound SMS matches on this. Two tenants may share a customer.
  UNIQUE (org_id, phone_e164),
  CHECK (email IS NOT NULL OR phone_e164 IS NOT NULL)
);
-- Lead list: newest first, keyset pagination on (created_at, id).
CREATE INDEX leads_org_created_idx ON leads (org_id, created_at DESC, id DESC);
CREATE INDEX leads_org_status_idx ON leads (org_id, status);
-- Search box: substring match over name, email and phone.
CREATE INDEX leads_search_trgm_idx ON leads USING gin (
  (coalesce(name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone_e164, '')) gin_trgm_ops
);

-- ───────────────────────────── conversations ─────────────────────────────

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  lead_id         uuid NOT NULL,
  -- The tenant's number this conversation runs on; replies are sent from it.
  phone_number_id uuid NOT NULL,
  channel         text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms')),
  mode            text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'manual')),
  -- Set with clock_timestamp() after the conversation lock is held (see PLAN.md §5.4).
  mode_changed_at timestamptz,
  mode_changed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, lead_id, channel),
  FOREIGN KEY (org_id, lead_id) REFERENCES leads (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, phone_number_id) REFERENCES phone_numbers (org_id, id)
);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  conversation_id     uuid NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author              text NOT NULL CHECK (author IN ('lead', 'ai', 'human', 'system')),
  body                text NOT NULL,
  status              text NOT NULL
                        CHECK (status IN ('received', 'sending', 'sent', 'delivered', 'failed', 'cancelled')),
  -- Twilio's MessageSid. Inbound: second layer of duplicate protection. Outbound: set once sent.
  provider_message_id text UNIQUE,
  -- Outbound only: one send per key (e.g. 'ai_reply:<inbound message id>').
  idempotency_key     text UNIQUE,
  error_code          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, conversation_id) REFERENCES conversations (org_id, id) ON DELETE CASCADE,
  -- Inbound messages come from the lead and are only ever 'received'.
  CHECK ((direction = 'inbound') = (author = 'lead')),
  CHECK ((direction = 'inbound') = (status = 'received')),
  CHECK (direction = 'inbound' OR idempotency_key IS NOT NULL)
);
CREATE INDEX messages_conversation_idx ON messages (org_id, conversation_id, created_at);

-- ───────────────────────────────── jobs ─────────────────────────────────

-- The durable job queue (PostgreSQL-backed instead of Redis; see PLAN.md §1).
CREATE TABLE workflow_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  conversation_id uuid,
  type            text NOT NULL CHECK (type IN ('ai_reply', 'follow_up')),
  payload         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'succeeded', 'cancelled', 'dead')),
  run_at          timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  -- Lease: which worker holds the job and until when. Also fences late updates from a worker
  -- whose lease already expired.
  locked_by       text,
  locked_until    timestamptz,
  -- Prevents enqueuing the same work twice (e.g. 'ai_reply:<inbound message id>').
  dedupe_key      text UNIQUE,
  last_error      text,
  cancel_reason   text,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  FOREIGN KEY (org_id, conversation_id) REFERENCES conversations (org_id, id) ON DELETE CASCADE,
  CHECK ((status = 'running') = (locked_by IS NOT NULL AND locked_until IS NOT NULL))
);
-- Claiming due work.
CREATE INDEX workflow_jobs_due_idx ON workflow_jobs (run_at) WHERE status = 'pending';
-- Reaping expired leases.
CREATE INDEX workflow_jobs_lease_idx ON workflow_jobs (locked_until) WHERE status = 'running';
-- Cancelling a conversation's pending jobs (handoff, STOP, closed lead).
CREATE INDEX workflow_jobs_conversation_idx ON workflow_jobs (conversation_id, status);

-- ─────────────────────────────── consent ───────────────────────────────

-- Keyed by (org, phone, channel), not by lead: suppression survives lead deletion and covers every
-- number the org owns. Rows are kept after re-opt-in (revoked_at set) as consent history.
CREATE TABLE opt_outs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  phone_e164            text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  channel               text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms')),
  keyword               text,
  source_message_id     uuid,
  opted_out_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  revoked_by_message_id uuid,
  -- Composite like every other tenant reference. When the message is deleted (with its lead), only
  -- the message column is cleared: the opt-out itself and its org_id must survive.
  FOREIGN KEY (org_id, source_message_id) REFERENCES messages (org_id, id)
    ON DELETE SET NULL (source_message_id),
  FOREIGN KEY (org_id, revoked_by_message_id) REFERENCES messages (org_id, id)
    ON DELETE SET NULL (revoked_by_message_id)
);
-- At most one active opt-out per phone per tenant per channel.
CREATE UNIQUE INDEX opt_outs_active_uq ON opt_outs (org_id, phone_e164, channel) WHERE revoked_at IS NULL;

-- ────────────────────────── audit and webhooks ──────────────────────────

CREATE TABLE audit_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL for platform-level events that belong to no tenant. RESTRICT on purpose: an organization
  -- with audit history can't be hard-deleted (the append-only trigger would refuse it anyway).
  org_id         uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'platform_admin', 'system', 'webhook')),
  actor_user_id  uuid REFERENCES users (id),
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  metadata       jsonb NOT NULL DEFAULT '{}',
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_created_idx ON audit_events (org_id, created_at DESC);

-- Audit history is append-only: changing or deleting it is refused at the database level.
CREATE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP;
END;
$$;
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

-- First layer of inbound duplicate protection: one row per provider event, inserted first in the
-- webhook transaction so a concurrent retry waits on the unique index and then sees the conflict.
CREATE TABLE webhook_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL CHECK (provider IN ('twilio')),
  provider_event_id text NOT NULL,
  org_id            uuid REFERENCES organizations (id) ON DELETE CASCADE,
  outcome           text NOT NULL CHECK (outcome IN ('processed', 'unroutable', 'ignored')),
  payload           jsonb NOT NULL,
  correlation_id    text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

-- ─────────────────────────────── mock only ───────────────────────────────

-- Stands in for Twilio's own record of what it actually sent. Used by the mock SMS adapter so tests
-- can count real provider sends across worker processes. client_ref is deliberately NOT unique:
-- real Twilio doesn't deduplicate, so tests prove our code never sends twice.
CREATE TABLE mock_provider_messages (
  sid        text PRIMARY KEY,
  client_ref text NOT NULL,
  from_e164  text NOT NULL,
  to_e164    text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mock_provider_messages_client_ref_idx ON mock_provider_messages (client_ref);
