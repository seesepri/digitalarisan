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

Never commit secret values. `BANK_PII_ENCRYPTION_KEY` must never be derived from or replaced by `AUTH_SECRET` in production. Rotate by provisioning a new secret, deploying, verifying, then revoking the old credential.
