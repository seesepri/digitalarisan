DO $$ BEGIN
  CREATE TYPE reconciliation_run_status AS ENUM ('PASS', 'FAIL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status reconciliation_run_status NOT NULL,
  scope varchar(32) NOT NULL DEFAULT 'GLOBAL',
  period_id uuid REFERENCES arisan_periods(id) ON DELETE RESTRICT,
  issue_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_runs_created_idx ON reconciliation_runs(created_at);
CREATE INDEX IF NOT EXISTS reconciliation_runs_period_idx ON reconciliation_runs(period_id);

CREATE TABLE IF NOT EXISTS reconciliation_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  severity varchar(16) NOT NULL DEFAULT 'CRITICAL',
  code varchar(80) NOT NULL,
  entity_type varchar(60) NOT NULL,
  entity_id uuid,
  expected_value jsonb,
  actual_value jsonb,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_issues_run_idx ON reconciliation_issues(run_id);
CREATE INDEX IF NOT EXISTS reconciliation_issues_code_idx ON reconciliation_issues(code);

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_issue_count_nonnegative CHECK (issue_count >= 0);
