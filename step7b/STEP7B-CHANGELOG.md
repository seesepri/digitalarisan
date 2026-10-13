# STEP 7B — Privacy Erasure + Retention Enforcement

Baseline: STEP 7A PASS (10/10).

## Changes
- ERASURE revokes every user session.
- ERASURE invalidates credentials and anonymizes user PII.
- ERASURE anonymizes direct bank-account PII on withdrawal records while retaining the financial rows and user FK.
- Financial ledger/history and audit evidence are never destructively deleted by the privacy lifecycle.
- Retention enforcement deletes expired/revoked sessions and expired rate-limit buckets.
- Retention enforcement anonymizes already-erased user PII after `COMPLIANCE_PII_RETENTION_DAYS` (default 90).
- Retention report exposes classified eligible PII counts and retained financial/audit counts.
- Privacy export remains authenticated, user-scoped, and allow-listed; password/session credentials and bank-account PII are excluded.
- Added `tests/privacy-erasure.test.ts` with 7 regression tests.

## Validation
- Shell syntax checks: PASS.
- Privacy regression tests via Node type stripping: 17/17 PASS.
- Full npm typecheck/lint/build could not be executed in the sandbox because dependency installation timed out; the release ZIP excludes the partial `node_modules` created during that attempt.
