ALTER TABLE topups ADD COLUMN IF NOT EXISTS checkout_url TEXT;

ALTER TABLE payment_webhook_events ADD COLUMN IF NOT EXISTS signature_timestamp VARCHAR(32);
ALTER TABLE payment_webhook_events ADD COLUMN IF NOT EXISTS payload_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS payment_webhook_topup_idx ON payment_webhook_events (topup_id);

-- Provider reference is required before a top-up can be paid through the webhook.
-- Existing rows are preserved; new provider-backed top-ups populate it before PROCESSING.
