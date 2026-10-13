CREATE TYPE kyc_status AS ENUM ('PENDING','IN_REVIEW','VERIFIED','REJECTED');
CREATE TYPE withdrawal_approval_status AS ENUM ('PENDING','APPROVED','REJECTED');
CREATE TYPE risk_status AS ENUM ('CLEAR','REVIEW','BLOCKED');
CREATE TYPE compliance_flag_status AS ENUM ('OPEN','RESOLVED','DISMISSED');

ALTER TABLE users ADD COLUMN kyc_status kyc_status NOT NULL DEFAULT 'PENDING';
ALTER TABLE users ADD COLUMN kyc_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN kyc_reviewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN kyc_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN kyc_rejection_reason TEXT;

ALTER TABLE withdrawals ADD COLUMN approval_status withdrawal_approval_status NOT NULL DEFAULT 'PENDING';
ALTER TABLE withdrawals ADD COLUMN approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE withdrawals ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE withdrawals ADD COLUMN approval_reason TEXT;
ALTER TABLE withdrawals ADD COLUMN risk_status risk_status NOT NULL DEFAULT 'CLEAR';
ALTER TABLE withdrawals ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_risk_score_valid CHECK (risk_score >= 0);
CREATE INDEX withdrawals_approval_status_idx ON withdrawals (approval_status, created_at);
CREATE INDEX withdrawals_risk_status_idx ON withdrawals (risk_status, created_at);

CREATE TABLE compliance_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  withdrawal_id UUID REFERENCES withdrawals(id) ON DELETE RESTRICT,
  rule_code VARCHAR(80) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  status compliance_flag_status NOT NULL DEFAULT 'OPEN',
  score INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT compliance_flags_score_valid CHECK (score >= 0)
);
CREATE INDEX compliance_flags_user_status_idx ON compliance_flags (user_id, status);
CREATE INDEX compliance_flags_withdrawal_idx ON compliance_flags (withdrawal_id);

COMMENT ON COLUMN users.kyc_status IS 'KYC lifecycle; VERIFIED is required for financial withdrawal.';
COMMENT ON COLUMN withdrawals.approval_status IS 'Maker-checker approval state; executor must differ from approver.';
COMMENT ON TABLE compliance_flags IS 'Risk/compliance review queue; never store raw KYC documents or full bank account numbers here.';
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_approved_by_required CHECK (approval_status <> 'APPROVED' OR approved_by IS NOT NULL);
ALTER TABLE users ADD CONSTRAINT users_kyc_verified_reviewer_required CHECK (kyc_status <> 'VERIFIED' OR kyc_reviewed_by IS NOT NULL);

CREATE OR REPLACE FUNCTION reject_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_immutable_update ON audit_logs;
CREATE TRIGGER audit_logs_immutable_update BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
DROP TRIGGER IF EXISTS audit_logs_immutable_delete ON audit_logs;
CREATE TRIGGER audit_logs_immutable_delete BEFORE DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
