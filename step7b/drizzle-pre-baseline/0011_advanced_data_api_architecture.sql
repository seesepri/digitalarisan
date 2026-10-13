-- v18 — Advanced Data & API Architecture
-- Additive-only: search/read-model/outbox infrastructure. No financial balances or ledger semantics change.

CREATE TABLE IF NOT EXISTS domain_event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type varchar(80) NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type varchar(120) NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error_code varchar(80),
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_event_outbox_version_valid CHECK (event_version > 0),
  CONSTRAINT domain_event_outbox_attempts_valid CHECK (attempt_count >= 0)
);
CREATE INDEX IF NOT EXISTS domain_event_outbox_pending_idx ON domain_event_outbox (published_at, next_attempt_at, occurred_at, id);
CREATE INDEX IF NOT EXISTS domain_event_outbox_aggregate_idx ON domain_event_outbox (aggregate_type, aggregate_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS arisan_period_read_models (
  period_id uuid PRIMARY KEY REFERENCES arisan_periods(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL,
  type_name varchar(160) NOT NULL,
  description text,
  contribution_amount bigint NOT NULL,
  minimum_participants integer NOT NULL,
  maximum_participants integer NOT NULL,
  registration_starts_at timestamptz NOT NULL,
  registration_ends_at timestamptz NOT NULL,
  drawing_at timestamptz NOT NULL,
  cancellation_deadline_at timestamptz NOT NULL,
  status period_status NOT NULL,
  active_participant_count integer NOT NULL DEFAULT 0,
  projection_version integer NOT NULL DEFAULT 1,
  projected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arisan_period_read_models_count_valid CHECK (active_participant_count >= 0)
);
CREATE INDEX IF NOT EXISTS arisan_period_read_models_listing_idx ON arisan_period_read_models (status, drawing_at, period_id);
CREATE INDEX IF NOT EXISTS arisan_period_read_models_search_idx ON arisan_period_read_models USING GIN (
  to_tsvector('simple', coalesce(code, '') || ' ' || coalesce(type_name, '') || ' ' || coalesce(description, ''))
);

-- Search indexes use PostgreSQL built-ins; no extension/superuser dependency.
CREATE INDEX IF NOT EXISTS users_search_fts_idx ON users USING GIN (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, ''))
);
CREATE INDEX IF NOT EXISTS arisan_types_search_fts_idx ON arisan_types USING GIN (
  to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, ''))
);

-- Partitioning readiness: time-ordered operational tables get deterministic indexes so a future
-- expand/contract partition migration can move data in bounded windows without changing APIs.
CREATE INDEX IF NOT EXISTS audit_logs_archive_window_idx ON audit_logs (created_at, id);
CREATE INDEX IF NOT EXISTS wallet_transactions_archive_window_idx ON wallet_transactions (created_at, id);
CREATE INDEX IF NOT EXISTS financial_transactions_archive_window_idx ON financial_transactions (created_at, id);
