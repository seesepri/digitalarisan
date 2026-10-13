#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL wajib di-set}"

SESSION_DAYS="${COMPLIANCE_SESSION_RETENTION_DAYS:-90}"
PII_DAYS="${COMPLIANCE_PII_RETENTION_DAYS:-90}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  --set=session_days="$SESSION_DAYS" \
  --set=pii_days="$PII_DAYS" <<'SQL'
BEGIN;

-- Ephemeral authentication state: retain only for the configured window.
DELETE FROM user_sessions
WHERE GREATEST(expires_at, COALESCE(revoked_at, expires_at))
  < now() - make_interval(days => :'session_days'::int);

-- Ephemeral rate-limit state has no financial/compliance value.
DELETE FROM rate_limit_buckets
WHERE expires_at < now();

-- Phone OTP challenge payload contains only temporary registration data and is
-- removed after expiry; provider-managed OTP secrets are never stored here.
DELETE FROM phone_verification_challenges
WHERE expires_at < now();

-- Withdrawal records remain financial history; only direct bank-account PII
-- is anonymized for already-erased users after the same retention window.
UPDATE withdrawals w
SET
  bank_name = '[REDACTED]',
  account_name = '[REDACTED]',
  account_number = '[REDACTED]',
  updated_at = now()
FROM users u
WHERE u.id = w.user_id
  AND u.password_hash = 'ERASED'
  AND u.updated_at < now() - make_interval(days => :'pii_days'::int);

-- Erased accounts are already credential-invalidated by the ERASURE lifecycle.
-- Keep the user row/FKs intact, but ensure PII remains anonymized after the
-- configured retention window. Financial and audit rows are never deleted here.
UPDATE users
SET
  name = 'Deleted User ' || left(id::text, 8),
  phone = 'deleted-' || left(id::text, 8) || '@invalid',
  email = 'deleted-' || left(id::text, 8) || '@invalid',
  avatar_url = NULL,
  password_hash = 'ERASED',
  phone_verified_at = NULL,
  kyc_verified_at = NULL,
  kyc_reviewed_at = NULL,
  kyc_reviewed_by = NULL,
  kyc_rejection_reason = NULL,
  updated_at = now()
WHERE password_hash = 'ERASED'
  AND updated_at < now() - make_interval(days => :'pii_days'::int);

COMMIT;
SQL
