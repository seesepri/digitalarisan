CREATE TYPE "job_status" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'FAILED_FINAL');

CREATE TABLE "job_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_key" varchar(120) NOT NULL,
  "status" "job_status" DEFAULT 'RUNNING' NOT NULL,
  "lease_token" varchar(120),
  "locked_until" timestamp with time zone,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "next_run_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "last_error_code" varchar(80),
  "last_error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_executions_job_key_unique" UNIQUE("job_key"),
  CONSTRAINT "job_executions_attempts_valid" CHECK ("attempt_count" >= 0 AND "max_attempts" > 0)
);

CREATE INDEX "job_executions_due_idx" ON "job_executions" ("status", "next_run_at");
CREATE INDEX "job_executions_lock_idx" ON "job_executions" ("status", "locked_until");
