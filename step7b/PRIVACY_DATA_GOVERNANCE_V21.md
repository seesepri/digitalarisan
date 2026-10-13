# Privacy Data Governance — Source Snapshot

**Status:** Technical source-code inventory only. This document is not a legal privacy notice, regulatory opinion, or proof of operational compliance. No production deployment settings or actual data-retention execution were verified in this audit.

## Data handled by the implementation

- Account/profile data: name, phone, email, avatar, account status and KYC status.
- Authentication state: password hash, session refresh-token hash, session metadata, expiry and revocation timestamps.
- Financial data: wallet balances, wallet and accounting ledger entries, contributions/reservations, top-ups, withdrawals, payout state, bank destination details, reconciliation and audit records.
- Operational/user data: notifications, privacy requests, consent evidence hash, risk/compliance flags, request IP/user-agent metadata, rate-limit buckets and job/provider status metadata.

## Implemented user data workflows

- Authenticated users can request an `EXPORT` or `ERASURE`; the implementation prevents more than one active request per user using a per-user database row lock and request throttling.
- The export endpoint scopes rows to the authenticated user and selects an allow-list of profile, wallet transaction, withdrawal status, notification, consent, and privacy-request fields. It does not include password/session credentials or bank account fields. Each exported collection is capped; the wallet/withdrawal/notification history limit is 500 rows.
- An administrator moves requests through `PENDING -> IN_PROGRESS -> COMPLETED|REJECTED`; the request row is locked during a decision and changes are audited.
- Completing an erasure revokes sessions, invalidates the password, anonymizes selected profile/KYC fields, suspends the account, and redacts bank details on withdrawal rows. Financial and audit history is retained; it is not deleted by this workflow.
- New registration begins with a phone number only, uses Twilio Verify SMS OTP, then collects name/password after code entry; the user, wallet, verified-phone timestamp, and session are created only after provider approval. Temporary challenge records contain the phone, optional legacy user ID, expiry and attempt state—but no OTP, name, or password—and expire after five minutes; expired rows are removed by retention enforcement. Legacy active accounts without a verified phone must pass OTP after a correct password before they receive a new session.
- Password recovery is available through the user's verified phone and Twilio Verify. The request response does not disclose whether the phone is registered; reset challenges use a dedicated purpose and Verify service. Completing reset stores a new password hash, revokes all active sessions, writes an audit event, and does not create a login session.
- The retention scripts default session and already-erased-user PII age thresholds to 90 days. They delete expired/revoked sessions and expired rate-limit buckets, and redact bank/profile PII for already-erased accounts after the threshold. They do not delete audit or financial ledgers. The report script lists audit/ledger retention settings and counts, but the enforcement script does not implement those audit/ledger deletion settings.

## Security and operational constraints

- Bank destination fields use AES-256-GCM application-layer encryption when new withdrawals are stored. The key is supplied through `BANK_PII_ENCRYPTION_KEY`; key backup, rotation, access separation, and production KMS/HSM use are deployment responsibilities and were not verified.
- Audit and financial ledger rows are append-only at database-trigger level in the baseline schema. Access restrictions and PostgreSQL role grants depend on the deployed database roles and were not verified against a live database.
- The in-repository export is a synchronous JSON API and is bounded by fixed per-collection row limits; complete pagination for larger histories is not implemented in that endpoint.

## UNKNOWN / NOT VERIFIED

- Approved legal basis, published privacy notice, consent wording/version lifecycle, data-subject response SLAs, and jurisdiction-specific retention obligations.
- Whether the production Twilio Verify service is configured, funded, and delivery-tested. No provider credentials are supplied in the source; Twilio credentials and a Verify Service SID must be provisioned out-of-band.
- Email collection/verification is not part of the new registration flow; legacy email addresses are optional profile data and are not verified by a workflow found in source.
- Actual production values for retention variables, scheduled execution cadence, backup encryption, backup retention/deletion, provider-side retention, and cross-border processing.
- Whether operators review export completeness for records beyond the endpoint limits and how erasure requests are assessed against statutory financial-record retention duties.
