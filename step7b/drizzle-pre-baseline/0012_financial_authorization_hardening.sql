CREATE TYPE "draw_authorization_status" AS ENUM ('REQUESTED', 'APPROVED', 'EXECUTING', 'EXECUTED');

CREATE TABLE "draw_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "period_id" uuid NOT NULL REFERENCES "arisan_periods"("id") ON DELETE RESTRICT,
  "requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "approved_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  "approved_at" timestamptz,
  "executed_at" timestamptz,
  "status" "draw_authorization_status" NOT NULL DEFAULT 'REQUESTED',
  "request_reason" text NOT NULL,
  "approval_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "draw_authorizations_checker_distinct" CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by")
);
CREATE UNIQUE INDEX "draw_authorizations_period_unique" ON "draw_authorizations" ("period_id");
CREATE INDEX "draw_authorizations_status_idx" ON "draw_authorizations" ("status", "created_at");
