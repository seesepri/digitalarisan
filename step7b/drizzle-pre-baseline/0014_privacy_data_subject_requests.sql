DO $$ BEGIN
  CREATE TYPE privacy_request_status AS ENUM ('PENDING','IN_PROGRESS','COMPLETED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE privacy_request_type AS ENUM ('EXPORT','ERASURE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type privacy_request_type NOT NULL,
  status privacy_request_status NOT NULL DEFAULT 'PENDING',
  reason text,
  processed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_requests_user_created_idx ON privacy_requests(user_id, created_at, id);
CREATE INDEX IF NOT EXISTS privacy_requests_status_created_idx ON privacy_requests(status, created_at, id);

CREATE TABLE IF NOT EXISTS privacy_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  policy_type varchar(40) NOT NULL,
  policy_version varchar(40) NOT NULL,
  granted boolean NOT NULL,
  evidence_hash varchar(64) NOT NULL,
  granted_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_consents_user_policy_idx ON privacy_consents(user_id, policy_type, granted_at, id);
