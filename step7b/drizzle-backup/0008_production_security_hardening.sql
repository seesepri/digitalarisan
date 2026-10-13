CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
  "bucket_key" varchar(240) PRIMARY KEY NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rate_limit_buckets_count_valid" CHECK ("count" >= 0)
);
CREATE INDEX IF NOT EXISTS "rate_limit_buckets_expires_idx" ON "rate_limit_buckets" ("expires_at");

ALTER TABLE "topups" ADD COLUMN IF NOT EXISTS "payment_create_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "topups" ADD COLUMN IF NOT EXISTS "last_payment_attempt_at" timestamp with time zone;
ALTER TABLE "topups" ADD COLUMN IF NOT EXISTS "last_payment_error_code" varchar(80);
ALTER TABLE "topups" ADD COLUMN IF NOT EXISTS "last_payment_error_message" text;
ALTER TABLE "topups" ADD CONSTRAINT "topups_payment_attempts_valid" CHECK ("payment_create_attempts" >= 0);
