#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL wajib di-set}"
AUDIT_YEARS="${COMPLIANCE_AUDIT_RETENTION_YEARS:-7}"
LEDGER_YEARS="${COMPLIANCE_LEDGER_RETENTION_YEARS:-10}"
SESSION_DAYS="${COMPLIANCE_SESSION_RETENTION_DAYS:-90}"
PII_DAYS="${COMPLIANCE_PII_RETENTION_DAYS:-90}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --set=audit_years="$AUDIT_YEARS" --set=ledger_years="$LEDGER_YEARS" --set=session_days="$SESSION_DAYS" --set=pii_days="$PII_DAYS" <<'SQL'
SELECT json_build_object(
  'generatedAt', now(),
  'policy', json_build_object('auditYears', :'audit_years'::int, 'ledgerYears', :'ledger_years'::int, 'sessionDays', :'session_days'::int, 'piiDays', :'pii_days'::int),
  'eligibleExpiredSessions', (SELECT count(*) FROM user_sessions WHERE expires_at < now() - make_interval(days => :'session_days'::int)),
  'expiredRateLimitBuckets', (SELECT count(*) FROM rate_limit_buckets WHERE expires_at < now()),
  'expiredPhoneVerificationChallenges', (SELECT count(*) FROM phone_verification_challenges WHERE expires_at < now()),
  'eligibleErasedUsersForPiiAnonymization', (SELECT count(*) FROM users WHERE password_hash = 'ERASED' AND updated_at < now() - make_interval(days => :'pii_days'::int)),
  'eligibleWithdrawalPiiRows', (SELECT count(*) FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE u.password_hash = 'ERASED' AND u.updated_at < now() - make_interval(days => :'pii_days'::int)),
  'auditRecords', (SELECT count(*) FROM audit_logs),
  'walletTransactions', (SELECT count(*) FROM wallet_transactions),
  'financialTransactions', (SELECT count(*) FROM financial_transactions),
  'complianceFlags', (SELECT count(*) FROM compliance_flags)
);
SQL
