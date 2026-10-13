DO $$ BEGIN
  CREATE TYPE financial_account_type AS ENUM ('ARISAN_POOL', 'PLATFORM_FEE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE financial_direction AS ENUM ('CREDIT', 'DEBIT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(180) NOT NULL,
  type financial_account_type NOT NULL,
  period_id uuid REFERENCES arisan_periods(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_accounts_balance_nonnegative CHECK (balance >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_accounts_code_unique
  ON financial_accounts(code);

CREATE UNIQUE INDEX IF NOT EXISTS financial_accounts_period_unique
  ON financial_accounts(period_id);

CREATE TABLE IF NOT EXISTS financial_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  direction financial_direction NOT NULL,
  amount bigint NOT NULL,
  balance_before bigint NOT NULL,
  balance_after bigint NOT NULL,
  reference_type varchar(60) NOT NULL,
  reference_id uuid,
  description text NOT NULL,
  idempotency_key varchar(180) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_transactions_amount_positive CHECK (amount > 0),
  CONSTRAINT financial_transactions_balance_nonnegative CHECK (balance_before >= 0 AND balance_after >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_transactions_idempotency_unique
  ON financial_transactions(idempotency_key);

CREATE INDEX IF NOT EXISTS financial_transactions_account_created_idx
  ON financial_transactions(account_id, created_at);

CREATE INDEX IF NOT EXISTS financial_transactions_reference_idx
  ON financial_transactions(reference_type, reference_id);

INSERT INTO financial_accounts (code, type, period_id, balance)
VALUES ('PLATFORM_FEE', 'PLATFORM_FEE', NULL, 0)
ON CONFLICT (code) DO NOTHING;

INSERT INTO financial_accounts (code, type, period_id, balance)
SELECT 'ARISAN_POOL:' || id::text, 'ARISAN_POOL', id, 0
FROM arisan_periods
ON CONFLICT (code) DO NOTHING;
