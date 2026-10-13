-- v5: Payout / Withdrawal state machine and retry semantics

-- Rename the legacy FAILED terminal state to FAILED_FINAL before adding retryable states.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'withdrawal_status'::regtype AND enumlabel = 'FAILED') THEN
    ALTER TYPE withdrawal_status RENAME VALUE 'FAILED' TO 'FAILED_FINAL';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'withdrawal_status'::regtype AND enumlabel = 'FAILED_RETRYABLE') THEN
    ALTER TYPE withdrawal_status ADD VALUE 'FAILED_RETRYABLE';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'payout_status'::regtype AND enumlabel = 'FAILED') THEN
    ALTER TYPE payout_status RENAME VALUE 'FAILED' TO 'FAILED_FINAL';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'payout_status'::regtype AND enumlabel = 'FAILED_RETRYABLE') THEN
    ALTER TYPE payout_status ADD VALUE 'FAILED_RETRYABLE';
  END IF;
END $$;

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code varchar(80),
  ADD COLUMN IF NOT EXISTS last_error_message text,
  ADD COLUMN IF NOT EXISTS provider_reference varchar(180);

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code varchar(80),
  ADD COLUMN IF NOT EXISTS last_error_message text,
  ADD COLUMN IF NOT EXISTS provider_reference varchar(180);

CREATE TABLE IF NOT EXISTS withdrawal_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id uuid NOT NULL REFERENCES withdrawals(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  from_status withdrawal_status NOT NULL,
  to_status withdrawal_status NOT NULL,
  idempotency_key varchar(220) NOT NULL,
  error_code varchar(80),
  error_message text,
  provider_reference varchar(180),
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT withdrawal_attempts_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT withdrawal_attempts_transition_unique UNIQUE (withdrawal_id, attempt_number, to_status)
);
CREATE INDEX IF NOT EXISTS withdrawal_attempts_withdrawal_created_idx ON withdrawal_attempts(withdrawal_id, created_at);

CREATE TABLE IF NOT EXISTS payout_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES payouts(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  from_status payout_status NOT NULL,
  to_status payout_status NOT NULL,
  idempotency_key varchar(220) NOT NULL,
  error_code varchar(80),
  error_message text,
  provider_reference varchar(180),
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_attempts_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT payout_attempts_transition_unique UNIQUE (payout_id, attempt_number, to_status)
);
CREATE INDEX IF NOT EXISTS payout_attempts_payout_created_idx ON payout_attempts(payout_id, created_at);

ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_attempt_count_nonnegative CHECK (attempt_count >= 0);
ALTER TABLE payouts ADD CONSTRAINT payouts_attempt_count_nonnegative CHECK (attempt_count >= 0);
