-- 0002_jobs: background work (the queue), stored in PostgreSQL.
--
-- Why a table and not Redis: a job is inserted in the SAME transaction as the message that
-- needs it, so a message can never be saved without its job (or the other way round).
-- All queue SQL lives in src/services/queue.ts, so it can be swapped for Redis/SQS later.

CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  type            text NOT NULL CHECK (type IN ('ai_reply')),
  -- One job per piece of work, e.g. 'ai_reply:<customer message id>'. A repeat insert does nothing.
  dedupe_key      text NOT NULL UNIQUE,
  -- pending → running → done, or back to pending to retry, or failed after max_attempts.
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  -- Not before this time (used to wait between retries).
  run_at          timestamptz NOT NULL DEFAULT now(),
  -- While running: when the worker's claim expires. A worker that crashed stops renewing it,
  -- and the job is handed to another worker after this time.
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'running') = (locked_until IS NOT NULL))
);

-- Finding work: only pending jobs are indexed, so the index stays small however many
-- finished jobs exist.
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'pending';
-- Finding jobs whose worker crashed.
CREATE INDEX jobs_expired_idx ON jobs (locked_until) WHERE status = 'running';
