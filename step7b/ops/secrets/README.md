# Production secrets

Create these files on the deployment host (mode 0600) or replace the Compose secret mechanism with your cloud secret manager:

- auth_secret
- bank_pii_encryption_key (base64, exactly 32 decoded bytes; required for production)
- cron_secret
- metrics_token
- midtrans_server_key
- payout_provider_api_key
- twilio_auth_token (SMS verification only; Twilio Verify service SID is configuration, not an auth token)
- postgres_password (only for the optional self-managed PostgreSQL profile)

Never commit secret values. `BANK_PII_ENCRYPTION_KEY` must never be derived from or replaced by `AUTH_SECRET` in production. Rotate API/auth credentials through a separately tested revoke/rollover procedure. **Do not apply that procedure blindly to BANK_PII_ENCRYPTION_KEY**: current `enc:v1` ciphertext has no key ID/keyring. Replacing the key alone makes historical records/backups unreadable. Bank-key rotation is BLOCKED until versioned decryption, re-encryption, preserved original backups/keys and restore tests are implemented. Never revoke the old bank key while any historical ciphertext/retained backup needs it.
