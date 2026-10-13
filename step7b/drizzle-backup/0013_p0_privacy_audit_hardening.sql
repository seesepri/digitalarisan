CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE withdrawals
  ALTER COLUMN bank_name TYPE text,
  ALTER COLUMN account_name TYPE text,
  ALTER COLUMN account_number TYPE text;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS sequence_no bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS prev_hash varchar(64),
  ADD COLUMN IF NOT EXISTS entry_hash varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_sequence_unique ON audit_logs(sequence_no);

ALTER TABLE audit_logs DISABLE TRIGGER USER;

DO $$
DECLARE
  r record;
  previous text := NULL;
  digest_value text;
BEGIN
  FOR r IN SELECT * FROM audit_logs ORDER BY sequence_no LOOP
    digest_value := encode(digest(
      coalesce(previous, '') || '|' ||
      r.id::text || '|' || coalesce(r.actor_id::text, '') || '|' || r.actor_type || '|' || r.action || '|' ||
      r.entity_type || '|' || coalesce(r.entity_id::text, '') || '|' ||
      coalesce(r.old_value::text, '') || '|' || coalesce(r.new_value::text, '') || '|' ||
      coalesce(r.ip_address, '') || '|' || coalesce(r.user_agent, '') || '|' || r.created_at::text,
      'sha256'
    ), 'hex');
    UPDATE audit_logs SET prev_hash = previous, entry_hash = digest_value WHERE id = r.id;
    previous := digest_value;
  END LOOP;
END $$;

ALTER TABLE audit_logs ENABLE TRIGGER USER;

ALTER TABLE audit_logs ALTER COLUMN entry_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_entry_hash_unique ON audit_logs(entry_hash);

CREATE OR REPLACE FUNCTION audit_logs_set_integrity_hash() RETURNS trigger AS $$
DECLARE
  previous text;
BEGIN
  PERFORM pg_advisory_xact_lock(84721931);
  SELECT entry_hash INTO previous FROM audit_logs ORDER BY sequence_no DESC LIMIT 1 FOR UPDATE;
  NEW.prev_hash := previous;
  NEW.entry_hash := encode(digest(
    coalesce(NEW.prev_hash, '') || '|' ||
    NEW.id::text || '|' || coalesce(NEW.actor_id::text, '') || '|' || NEW.actor_type || '|' || NEW.action || '|' ||
    NEW.entity_type || '|' || coalesce(NEW.entity_id::text, '') || '|' ||
    coalesce(NEW.old_value::text, '') || '|' || coalesce(NEW.new_value::text, '') || '|' ||
    coalesce(NEW.ip_address, '') || '|' || coalesce(NEW.user_agent, '') || '|' || NEW.created_at::text,
    'sha256'
  ), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_integrity_insert ON audit_logs;
CREATE TRIGGER audit_logs_integrity_insert
BEFORE INSERT ON audit_logs
FOR EACH ROW EXECUTE FUNCTION audit_logs_set_integrity_hash();

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_entry_hash_format CHECK (entry_hash ~ '^[0-9a-f]{64}$');
