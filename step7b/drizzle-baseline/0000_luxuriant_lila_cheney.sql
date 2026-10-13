CREATE TYPE "public"."compliance_flag_status" AS ENUM('OPEN', 'RESOLVED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."draw_authorization_status" AS ENUM('REQUESTED', 'APPROVED', 'EXECUTING', 'EXECUTED');--> statement-breakpoint
CREATE TYPE "public"."financial_account_type" AS ENUM('ARISAN_POOL', 'PLATFORM_FEE');--> statement-breakpoint
CREATE TYPE "public"."financial_direction" AS ENUM('CREDIT', 'DEBIT');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('RUNNING', 'SUCCESS', 'FAILED', 'FAILED_FINAL');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."participant_status" AS ENUM('ACTIVE', 'CANCELLED', 'WINNER', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED_RETRYABLE', 'FAILED_FINAL');--> statement-breakpoint
CREATE TYPE "public"."period_status" AS ENUM('DRAFT', 'OPEN', 'FULL', 'LOCKED', 'DRAWING', 'PAYOUT_PROCESSING', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_type" AS ENUM('EXPORT', 'ERASURE');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_run_status" AS ENUM('PASS', 'FAIL');--> statement-breakpoint
CREATE TYPE "public"."risk_status" AS ENUM('CLEAR', 'REVIEW', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."topup_status" AS ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('USER', 'ADMIN', 'SUPER_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'SUSPENDED', 'PENDING');--> statement-breakpoint
CREATE TYPE "public"."wallet_direction" AS ENUM('CREDIT', 'DEBIT');--> statement-breakpoint
CREATE TYPE "public"."wallet_reservation_status" AS ENUM('ACTIVE', 'RELEASED', 'CONSUMED');--> statement-breakpoint
CREATE TYPE "public"."wallet_tx_status" AS ENUM('PENDING', 'SUCCESS', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."wallet_tx_type" AS ENUM('TOPUP', 'JOIN_ARISAN', 'CANCEL_ARISAN', 'UNLOCK_ARISAN', 'PAYOUT', 'WITHDRAW', 'REFUND', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_status" AS ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "arisan_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"contribution_amount" bigint NOT NULL,
	"status" "participant_status" DEFAULT 'ACTIVE' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eligible_for_drawing" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arisan_participants_contribution_positive" CHECK ("arisan_participants"."contribution_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "arisan_period_read_models" (
	"period_id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"type_name" varchar(160) NOT NULL,
	"description" text,
	"contribution_amount" bigint NOT NULL,
	"minimum_participants" integer NOT NULL,
	"maximum_participants" integer NOT NULL,
	"registration_starts_at" timestamp with time zone NOT NULL,
	"registration_ends_at" timestamp with time zone NOT NULL,
	"drawing_at" timestamp with time zone NOT NULL,
	"cancellation_deadline_at" timestamp with time zone NOT NULL,
	"status" "period_status" NOT NULL,
	"active_participant_count" integer DEFAULT 0 NOT NULL,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arisan_period_read_models_count_valid" CHECK ("arisan_period_read_models"."active_participant_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "arisan_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"registration_starts_at" timestamp with time zone NOT NULL,
	"registration_ends_at" timestamp with time zone NOT NULL,
	"drawing_at" timestamp with time zone NOT NULL,
	"cancellation_deadline_at" timestamp with time zone NOT NULL,
	"minimum_participants" integer NOT NULL,
	"maximum_participants" integer NOT NULL,
	"contribution_amount" bigint NOT NULL,
	"platform_fee_bps" integer DEFAULT 0 NOT NULL,
	"status" "period_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arisan_period_dates_valid" CHECK ("arisan_periods"."registration_starts_at" < "arisan_periods"."registration_ends_at" AND "arisan_periods"."registration_ends_at" <= "arisan_periods"."drawing_at" AND "arisan_periods"."cancellation_deadline_at" < "arisan_periods"."drawing_at"),
	CONSTRAINT "arisan_period_participants_valid" CHECK ("arisan_periods"."minimum_participants" >= 2 AND "arisan_periods"."maximum_participants" >= "arisan_periods"."minimum_participants"),
	CONSTRAINT "arisan_period_contribution_positive" CHECK ("arisan_periods"."contribution_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "arisan_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"contribution_amount" bigint NOT NULL,
	"minimum_participants" integer DEFAULT 2 NOT NULL,
	"maximum_participants" integer NOT NULL,
	"cancellation_deadline_days" integer DEFAULT 2 NOT NULL,
	"drawing_method" varchar(40) DEFAULT 'CSPRNG' NOT NULL,
	"platform_fee_bps" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arisan_type_contribution_positive" CHECK ("arisan_types"."contribution_amount" > 0),
	CONSTRAINT "arisan_type_participants_valid" CHECK ("arisan_types"."minimum_participants" >= 2 AND "arisan_types"."maximum_participants" >= "arisan_types"."minimum_participants"),
	CONSTRAINT "arisan_type_cancellation_days_valid" CHECK ("arisan_types"."cancellation_deadline_days" >= 0),
	CONSTRAINT "arisan_type_fee_valid" CHECK ("arisan_types"."platform_fee_bps" >= 0 AND "arisan_types"."platform_fee_bps" <= 10000)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence_no" bigint GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_sequence_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"prev_hash" varchar(64),
	"entry_hash" varchar(64) DEFAULT '' NOT NULL,
	"actor_id" uuid,
	"actor_type" varchar(32) NOT NULL,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(60) NOT NULL,
	"entity_id" uuid,
	"old_value" jsonb,
	"new_value" jsonb,
	"ip_address" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"withdrawal_id" uuid,
	"rule_code" varchar(80) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"status" "compliance_flag_status" DEFAULT 'OPEN' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_flags_score_valid" CHECK ("compliance_flags"."score" >= 0)
);
--> statement-breakpoint
CREATE TABLE "domain_event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_event_outbox_version_valid" CHECK ("domain_event_outbox"."event_version" > 0),
	CONSTRAINT "domain_event_outbox_attempts_valid" CHECK ("domain_event_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "draw_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"status" "draw_authorization_status" DEFAULT 'REQUESTED' NOT NULL,
	"request_reason" text NOT NULL,
	"approval_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draw_authorizations_checker_distinct" CHECK ("draw_authorizations"."approved_by" IS NULL OR "draw_authorizations"."approved_by" <> "draw_authorizations"."requested_by")
);
--> statement-breakpoint
CREATE TABLE "drawings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"selection_method" varchar(40) DEFAULT 'NODE_CRYPTO_RANDOM_INT' NOT NULL,
	"eligible_participant_count" integer NOT NULL,
	"selected_participant_id" uuid NOT NULL,
	"random_reference" varchar(180) NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_by" uuid,
	"status" varchar(24) DEFAULT 'SUCCESS' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(180) NOT NULL,
	"type" "financial_account_type" NOT NULL,
	"period_id" uuid,
	"balance" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_accounts_balance_nonnegative" CHECK ("financial_accounts"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "financial_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" "financial_direction" NOT NULL,
	"amount" bigint NOT NULL,
	"balance_before" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reference_type" varchar(60) NOT NULL,
	"reference_id" uuid,
	"description" text NOT NULL,
	"idempotency_key" varchar(180) NOT NULL,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_transactions_amount_positive" CHECK ("financial_transactions"."amount" > 0),
	CONSTRAINT "financial_transactions_balance_nonnegative" CHECK ("financial_transactions"."balance_before" >= 0 AND "financial_transactions"."balance_after" >= 0)
);
--> statement-breakpoint
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
	CONSTRAINT "job_executions_attempts_valid" CHECK ("job_executions"."attempt_count" >= 0 AND "job_executions"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(140) NOT NULL,
	"message" text NOT NULL,
	"type" varchar(40) NOT NULL,
	"read_at" timestamp with time zone,
	"reference_type" varchar(40),
	"reference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(48) NOT NULL,
	"provider_event_id" varchar(180) NOT NULL,
	"topup_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature_timestamp" varchar(32),
	"payload_hash" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "payout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payout_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"from_status" "payout_status" NOT NULL,
	"to_status" "payout_status" NOT NULL,
	"idempotency_key" varchar(220) NOT NULL,
	"error_code" varchar(80),
	"error_message" text,
	"provider_reference" varchar(180),
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"gross_amount" bigint NOT NULL,
	"fee_amount" bigint DEFAULT 0 NOT NULL,
	"net_amount" bigint NOT NULL,
	"idempotency_key" varchar(180) NOT NULL,
	"status" "payout_status" DEFAULT 'PENDING' NOT NULL,
	"processed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"last_error_message" text,
	"provider_reference" varchar(180),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_amounts_valid" CHECK ("payouts"."gross_amount" > 0 AND "payouts"."fee_amount" >= 0 AND "payouts"."net_amount" >= 0 AND "payouts"."gross_amount" = "payouts"."fee_amount" + "payouts"."net_amount")
);
--> statement-breakpoint
CREATE TABLE "platform_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"payout_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_fees_amount_nonnegative" CHECK ("platform_fees"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "privacy_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"policy_type" varchar(40) NOT NULL,
	"policy_version" varchar(40) NOT NULL,
	"granted" boolean NOT NULL,
	"evidence_hash" varchar(64) NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "privacy_request_type" NOT NULL,
	"status" "privacy_request_status" DEFAULT 'PENDING' NOT NULL,
	"reason" text,
	"processed_by" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"bucket_key" varchar(240) PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_buckets_count_valid" CHECK ("rate_limit_buckets"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"severity" varchar(16) DEFAULT 'CRITICAL' NOT NULL,
	"code" varchar(80) NOT NULL,
	"entity_type" varchar(60) NOT NULL,
	"entity_id" uuid,
	"expected_value" jsonb,
	"actual_value" jsonb,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "reconciliation_run_status" NOT NULL,
	"scope" varchar(32) DEFAULT 'GLOBAL' NOT NULL,
	"period_id" uuid,
	"issue_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"provider" varchar(48) NOT NULL,
	"provider_reference" varchar(180),
	"checkout_url" text,
	"idempotency_key" varchar(180) NOT NULL,
	"status" "topup_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"payment_create_attempts" integer DEFAULT 0 NOT NULL,
	"last_payment_attempt_at" timestamp with time zone,
	"last_payment_error_code" varchar(80),
	"last_payment_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topups_amount_positive" CHECK ("topups"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"phone" varchar(24) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"avatar_url" text,
	"role" "user_role" DEFAULT 'USER' NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"phone_verified_at" timestamp with time zone,
	"kyc_status" "kyc_status" DEFAULT 'PENDING' NOT NULL,
	"kyc_verified_at" timestamp with time zone,
	"kyc_reviewed_at" timestamp with time zone,
	"kyc_reviewed_by" uuid,
	"kyc_rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "wallet_reservation_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "wallet_reservations_amount_positive" CHECK ("wallet_reservations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "wallet_tx_type" NOT NULL,
	"direction" "wallet_direction" NOT NULL,
	"amount" bigint NOT NULL,
	"available_before" bigint NOT NULL,
	"available_after" bigint NOT NULL,
	"locked_before" bigint NOT NULL,
	"locked_after" bigint NOT NULL,
	"pending_before" bigint NOT NULL,
	"pending_after" bigint NOT NULL,
	"reference_type" varchar(40) NOT NULL,
	"reference_id" uuid,
	"description" text NOT NULL,
	"status" "wallet_tx_status" DEFAULT 'SUCCESS' NOT NULL,
	"idempotency_key" varchar(180) NOT NULL,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_transactions_amount_positive" CHECK ("wallet_transactions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"available_balance" bigint DEFAULT 0 NOT NULL,
	"locked_balance" bigint DEFAULT 0 NOT NULL,
	"pending_balance" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_available_nonnegative" CHECK ("wallets"."available_balance" >= 0),
	CONSTRAINT "wallet_locked_nonnegative" CHECK ("wallets"."locked_balance" >= 0),
	CONSTRAINT "wallet_pending_nonnegative" CHECK ("wallets"."pending_balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "winners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"prize_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawal_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"withdrawal_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"from_status" "withdrawal_status" NOT NULL,
	"to_status" "withdrawal_status" NOT NULL,
	"idempotency_key" varchar(220) NOT NULL,
	"error_code" varchar(80),
	"error_message" text,
	"provider_reference" varchar(180),
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"bank_name" text NOT NULL,
	"account_name" text NOT NULL,
	"account_number" text NOT NULL,
	"idempotency_key" varchar(180) NOT NULL,
	"status" "withdrawal_status" DEFAULT 'PENDING' NOT NULL,
	"approval_status" "withdrawal_approval_status" DEFAULT 'PENDING' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_reason" text,
	"risk_status" "risk_status" DEFAULT 'CLEAR' NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"last_error_message" text,
	"provider_reference" varchar(180),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_amount_positive" CHECK ("withdrawals"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "arisan_participants" ADD CONSTRAINT "arisan_participants_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arisan_participants" ADD CONSTRAINT "arisan_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arisan_period_read_models" ADD CONSTRAINT "arisan_period_read_models_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arisan_periods" ADD CONSTRAINT "arisan_periods_type_id_arisan_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."arisan_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_flags" ADD CONSTRAINT "compliance_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_flags" ADD CONSTRAINT "compliance_flags_withdrawal_id_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_flags" ADD CONSTRAINT "compliance_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draw_authorizations" ADD CONSTRAINT "draw_authorizations_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draw_authorizations" ADD CONSTRAINT "draw_authorizations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draw_authorizations" ADD CONSTRAINT "draw_authorizations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_selected_participant_id_arisan_participants_id_fk" FOREIGN KEY ("selected_participant_id") REFERENCES "public"."arisan_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_account_id_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_reversal_of_id_financial_transactions_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."financial_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_topup_id_topups_id_fk" FOREIGN KEY ("topup_id") REFERENCES "public"."topups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_fees" ADD CONSTRAINT "platform_fees_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_fees" ADD CONSTRAINT "platform_fees_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_kyc_reviewed_by_users_id_fk" FOREIGN KEY ("kyc_reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_participant_id_arisan_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."arisan_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_reservations" ADD CONSTRAINT "wallet_reservations_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_reversal_of_id_wallet_transactions_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_period_id_arisan_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."arisan_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_participant_id_arisan_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."arisan_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_attempts" ADD CONSTRAINT "withdrawal_attempts_withdrawal_id_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "arisan_participants_period_user_unique" ON "arisan_participants" USING btree ("period_id","user_id");--> statement-breakpoint
CREATE INDEX "arisan_participants_period_status_idx" ON "arisan_participants" USING btree ("period_id","status");--> statement-breakpoint
CREATE INDEX "arisan_participants_user_status_created_idx" ON "arisan_participants" USING btree ("user_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "arisan_participants_user_idx" ON "arisan_participants" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "arisan_period_read_models_listing_idx" ON "arisan_period_read_models" USING btree ("status","drawing_at","period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "arisan_periods_code_unique" ON "arisan_periods" USING btree ("code");--> statement-breakpoint
CREATE INDEX "arisan_periods_status_drawing_idx" ON "arisan_periods" USING btree ("status","drawing_at","id");--> statement-breakpoint
CREATE INDEX "arisan_types_active_idx" ON "arisan_types" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_sequence_unique" ON "audit_logs" USING btree ("sequence_no");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_entry_hash_unique" ON "audit_logs" USING btree ("entry_hash");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" USING btree ("actor_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_created_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "compliance_flags_user_status_idx" ON "compliance_flags" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "compliance_flags_status_created_idx" ON "compliance_flags" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "compliance_flags_withdrawal_idx" ON "compliance_flags" USING btree ("withdrawal_id");--> statement-breakpoint
CREATE INDEX "domain_event_outbox_pending_idx" ON "domain_event_outbox" USING btree ("published_at","next_attempt_at","occurred_at","id");--> statement-breakpoint
CREATE INDEX "domain_event_outbox_aggregate_idx" ON "domain_event_outbox" USING btree ("aggregate_type","aggregate_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "draw_authorizations_period_unique" ON "draw_authorizations" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "draw_authorizations_status_idx" ON "draw_authorizations" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drawings_period_unique" ON "drawings" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "drawings_executed_at_idx" ON "drawings" USING btree ("executed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_accounts_code_unique" ON "financial_accounts" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_accounts_period_unique" ON "financial_accounts" USING btree ("period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_transactions_idempotency_unique" ON "financial_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "financial_transactions_account_created_idx" ON "financial_transactions" USING btree ("account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "financial_transactions_reference_idx" ON "financial_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_executions_job_key_unique" ON "job_executions" USING btree ("job_key");--> statement-breakpoint
CREATE INDEX "job_executions_due_idx" ON "job_executions" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "job_executions_lock_idx" ON "job_executions" USING btree ("status","locked_until");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_created_idx" ON "notifications" USING btree ("user_id","read_at","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_user_type_reference_unique" ON "notifications" USING btree ("user_id","type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_provider_event_unique" ON "payment_webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_topup_idx" ON "payment_webhook_events" USING btree ("topup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_attempts_idempotency_unique" ON "payout_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_attempts_transition_unique" ON "payout_attempts" USING btree ("payout_id","attempt_number","to_status");--> statement-breakpoint
CREATE INDEX "payout_attempts_payout_created_idx" ON "payout_attempts" USING btree ("payout_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_period_unique" ON "payouts" USING btree ("period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_idempotency_unique" ON "payouts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_fees_period_unique" ON "platform_fees" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "privacy_consents_user_policy_idx" ON "privacy_consents" USING btree ("user_id","policy_type","granted_at","id");--> statement-breakpoint
CREATE INDEX "privacy_requests_user_created_idx" ON "privacy_requests" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "privacy_requests_status_created_idx" ON "privacy_requests" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expires_idx" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "reconciliation_issues_run_idx" ON "reconciliation_issues" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "reconciliation_issues_code_idx" ON "reconciliation_issues" USING btree ("code");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_created_idx" ON "reconciliation_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_period_idx" ON "reconciliation_runs" USING btree ("period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topups_idempotency_unique" ON "topups" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "topups_provider_reference_unique" ON "topups" USING btree ("provider_reference");--> statement-breakpoint
CREATE INDEX "topups_user_created_idx" ON "topups" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "topups_status_expires_idx" ON "topups" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_refresh_hash_unique" ON "user_sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_unique" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_status_created_idx" ON "users" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_reservations_participant_unique" ON "wallet_reservations" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "wallet_reservations_wallet_status_idx" ON "wallet_reservations" USING btree ("wallet_id","status");--> statement-breakpoint
CREATE INDEX "wallet_reservations_user_status_idx" ON "wallet_reservations" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "wallet_reservations_period_status_idx" ON "wallet_reservations" USING btree ("period_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_idempotency_unique" ON "wallet_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "wallet_transactions_user_created_idx" ON "wallet_transactions" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "wallet_transactions_reference_idx" ON "wallet_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_user_unique" ON "wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "winners_period_unique" ON "winners" USING btree ("period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "winners_participant_unique" ON "winners" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawal_attempts_idempotency_unique" ON "withdrawal_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawal_attempts_transition_unique" ON "withdrawal_attempts" USING btree ("withdrawal_id","attempt_number","to_status");--> statement-breakpoint
CREATE INDEX "withdrawal_attempts_withdrawal_created_idx" ON "withdrawal_attempts" USING btree ("withdrawal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawals_idempotency_unique" ON "withdrawals" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "withdrawals_user_created_idx" ON "withdrawals" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "withdrawals_status_retry_idx" ON "withdrawals" USING btree ("status","next_retry_at");