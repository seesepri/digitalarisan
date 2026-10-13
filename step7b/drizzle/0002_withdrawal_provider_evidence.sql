-- Additive safety patch. No legacy withdrawal status, balance, error, or provider reference is repaired here.
ALTER TABLE withdrawals ADD COLUMN provider varchar(48);
--> statement-breakpoint
ALTER TABLE withdrawals ADD COLUMN last_provider_evidence jsonb;
--> statement-breakpoint
ALTER TABLE withdrawal_attempts ADD COLUMN provider_evidence jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX withdrawals_provider_reference_unique ON withdrawals (provider, provider_reference)
WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;
--> statement-breakpoint
-- NOT VALID retains anomalous historical rows for investigation, while rejecting new invalid mutations.
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_state_metadata_valid CHECK (
  attempt_count BETWEEN 0 AND 5 AND
  COALESCE(CASE status
    WHEN 'PENDING' THEN attempt_count = 0 AND next_retry_at IS NULL AND processed_at IS NULL
    WHEN 'PROCESSING' THEN attempt_count > 0 AND next_retry_at IS NULL AND processed_at IS NULL AND last_error_code IS NULL AND last_error_message IS NULL
    WHEN 'SUCCESS' THEN processed_at IS NOT NULL AND next_retry_at IS NULL AND last_error_code IS NULL AND last_error_message IS NULL
      AND btrim(provider_reference) <> '' AND btrim(provider) <> ''
      AND last_provider_evidence->>'status' = 'SUCCESS'
    WHEN 'FAILED_RETRYABLE' THEN attempt_count BETWEEN 1 AND 4 AND processed_at IS NULL AND next_retry_at IS NOT NULL
      AND last_error_code = 'PROVIDER_RETRYABLE_FAILURE' AND btrim(provider_reference) <> '' AND btrim(provider) <> ''
      AND last_provider_evidence->>'status' = 'FAILED_RETRYABLE' AND last_provider_evidence->>'failureConfirmed' = 'true'
    WHEN 'FAILED_FINAL' THEN processed_at IS NOT NULL AND next_retry_at IS NULL
      AND last_error_code IN ('PROVIDER_FINAL_FAILURE', 'PROVIDER_RETRIES_EXHAUSTED')
      AND btrim(provider_reference) <> '' AND btrim(provider) <> ''
      AND last_provider_evidence->>'status' IN ('FAILED_FINAL', 'FAILED_RETRYABLE') AND last_provider_evidence->>'failureConfirmed' = 'true'
    WHEN 'CANCELLED' THEN next_retry_at IS NULL
    ELSE false END, false)
  AND COALESCE(CASE WHEN status IN ('SUCCESS', 'FAILED_RETRYABLE', 'FAILED_FINAL') THEN
    last_provider_evidence->>'providerReference' = provider_reference
    AND last_provider_evidence->>'provider' = provider
    AND last_provider_evidence->>'reference' = 'WD-' || substr(encode(digest(id::text, 'sha256'), 'hex'), 1, 32)
    AND last_provider_evidence->>'amount' = amount::text
    AND last_provider_evidence->>'currency' = 'IDR'
    ELSE true END, false)
) NOT VALID;
--> statement-breakpoint
CREATE FUNCTION enforce_withdrawal_retry_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SUCCESS', 'FAILED_FINAL', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'WITHDRAWAL_TERMINAL: terminal withdrawal cannot change state' USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    RAISE EXCEPTION 'PAYOUT_PROVIDER_REFERENCE_CONFLICT' USING ERRCODE = '23514';
  END IF;
  IF OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'PAYOUT_PROVIDER_CONFIG_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.bank_name IS DISTINCT FROM OLD.bank_name OR NEW.account_name IS DISTINCT FROM OLD.account_name
    OR NEW.account_number IS DISTINCT FROM OLD.account_number THEN
    RAISE EXCEPTION 'WITHDRAWAL_FINANCIAL_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'PROCESSING' AND OLD.status <> 'PROCESSING' THEN
    IF OLD.status NOT IN ('PENDING', 'FAILED_RETRYABLE') THEN
      RAISE EXCEPTION 'INVALID_WITHDRAWAL_TRANSITION' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'FAILED_RETRYABLE' AND (OLD.next_retry_at IS NULL OR OLD.next_retry_at > clock_timestamp()) THEN
      RAISE EXCEPTION 'WITHDRAWAL_RETRY_NOT_DUE' USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.attempt_count > 5 THEN
      RAISE EXCEPTION 'WITHDRAWAL_ATTEMPT_COUNT_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.attempt_count IS DISTINCT FROM OLD.attempt_count THEN
    RAISE EXCEPTION 'WITHDRAWAL_ATTEMPT_COUNT_INVALID' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER withdrawals_retry_transition_guard BEFORE UPDATE ON withdrawals
FOR EACH ROW EXECUTE FUNCTION enforce_withdrawal_retry_transition();
--> statement-breakpoint
ALTER TABLE withdrawal_attempts ALTER COLUMN created_at SET DEFAULT clock_timestamp();
--> statement-breakpoint
ALTER TABLE payout_attempts ALTER COLUMN created_at SET DEFAULT clock_timestamp();
