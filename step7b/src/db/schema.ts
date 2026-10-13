import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userRoleEnum = pgEnum("user_role", ["USER", "ADMIN", "SUPER_ADMIN"]);
export const userStatusEnum = pgEnum("user_status", ["ACTIVE", "SUSPENDED", "PENDING"]);
export const phoneVerificationPurposeEnum = pgEnum("phone_verification_purpose", ["SIGNUP", "LOGIN_VERIFY", "PASSWORD_RESET"]);
export const walletTxTypeEnum = pgEnum("wallet_tx_type", [
  "TOPUP",
  "JOIN_ARISAN",
  "CANCEL_ARISAN",
  "UNLOCK_ARISAN",
  "PAYOUT",
  "WITHDRAW",
  "REFUND",
  "ADJUSTMENT",
]);
export const walletDirectionEnum = pgEnum("wallet_direction", ["CREDIT", "DEBIT"]);
export const walletTxStatusEnum = pgEnum("wallet_tx_status", ["PENDING", "SUCCESS", "FAILED"]);
export const periodStatusEnum = pgEnum("period_status", [
  "DRAFT",
  "OPEN",
  "FULL",
  "LOCKED",
  "DRAWING",
  "PAYOUT_PROCESSING",
  "COMPLETED",
  "CANCELLED",
]);
export const participantStatusEnum = pgEnum("participant_status", ["ACTIVE", "CANCELLED", "WINNER", "COMPLETED"]);
export const topupStatusEnum = pgEnum("topup_status", ["PENDING", "PROCESSING", "SUCCESS", "FAILED", "EXPIRED"]);
export const withdrawalStatusEnum = pgEnum("withdrawal_status", ["PENDING", "PROCESSING", "SUCCESS", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCELLED"]);
export const payoutStatusEnum = pgEnum("payout_status", ["PENDING", "PROCESSING", "SUCCESS", "FAILED_RETRYABLE", "FAILED_FINAL"]);
export const financialAccountTypeEnum = pgEnum("financial_account_type", ["ARISAN_POOL", "PLATFORM_FEE"]);
export const financialDirectionEnum = pgEnum("financial_direction", ["CREDIT", "DEBIT"]);
export const walletReservationStatusEnum = pgEnum("wallet_reservation_status", ["ACTIVE", "RELEASED", "CONSUMED"]);
export const reconciliationRunStatusEnum = pgEnum("reconciliation_run_status", ["PASS", "FAIL"]);
export const jobStatusEnum = pgEnum("job_status", ["RUNNING", "SUCCESS", "FAILED", "FAILED_FINAL"]);
export const kycStatusEnum = pgEnum("kyc_status", ["PENDING", "IN_REVIEW", "VERIFIED", "REJECTED"]);
export const withdrawalApprovalStatusEnum = pgEnum("withdrawal_approval_status", ["PENDING", "APPROVED", "REJECTED"]);
export const riskStatusEnum = pgEnum("risk_status", ["CLEAR", "REVIEW", "BLOCKED"]);
export const complianceFlagStatusEnum = pgEnum("compliance_flag_status", ["OPEN", "RESOLVED", "DISMISSED"]);
export const privacyRequestStatusEnum = pgEnum("privacy_request_status", ["PENDING", "IN_PROGRESS", "COMPLETED", "REJECTED"]);
export const privacyRequestTypeEnum = pgEnum("privacy_request_type", ["EXPORT", "ERASURE"]);
export const drawAuthorizationStatusEnum = pgEnum("draw_authorization_status", ["REQUESTED", "APPROVED", "EXECUTING", "EXECUTED"]);
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    bucketKey: varchar("bucket_key", { length: 240 }).primaryKey(),
    count: integer("count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [index("rate_limit_buckets_expires_idx").on(table.expiresAt), check("rate_limit_buckets_count_valid", sql`${table.count} >= 0`)],
);

const rupiah = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    phone: varchar("phone", { length: 24 }).notNull(),
    email: varchar("email", { length: 255 }),
    passwordHash: text("password_hash").notNull(),
    avatarUrl: text("avatar_url"),
    role: userRoleEnum("role").notNull().default("USER"),
    status: userStatusEnum("status").notNull().default("ACTIVE"),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true, mode: "date" }),
    kycStatus: kycStatusEnum("kyc_status").notNull().default("PENDING"),
    kycVerifiedAt: timestamp("kyc_verified_at", { withTimezone: true, mode: "date" }),
    kycReviewedAt: timestamp("kyc_reviewed_at", { withTimezone: true, mode: "date" }),
    kycReviewedBy: uuid("kyc_reviewed_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    kycRejectionReason: text("kyc_rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("users_phone_unique").on(table.phone), uniqueIndex("users_email_unique").on(table.email), index("users_status_created_idx").on(table.status, table.createdAt)],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    userAgent: text("user_agent"),
    ipAddress: varchar("ip_address", { length: 64 }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("user_sessions_refresh_hash_unique").on(table.refreshTokenHash), index("user_sessions_user_idx").on(table.userId)],
);

export const phoneVerificationChallenges = pgTable(
  "phone_verification_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phone: varchar("phone", { length: 24 }).notNull(),
    purpose: phoneVerificationPurposeEnum("purpose").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    verificationAttempts: integer("verification_attempts").notNull().default(0),
    verificationToken: uuid("verification_token"),
    verificationStartedAt: timestamp("verification_started_at", { withTimezone: true, mode: "date" }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("phone_verification_challenges_phone_unique").on(table.phone),
    index("phone_verification_challenges_expires_idx").on(table.expiresAt),
    check("phone_verification_challenges_attempts_valid", sql`${table.verificationAttempts} >= 0`),
  ],
);

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    availableBalance: rupiah("available_balance").notNull().default(0),
    lockedBalance: rupiah("locked_balance").notNull().default(0),
    pendingBalance: rupiah("pending_balance").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("wallets_user_unique").on(table.userId),
    check("wallet_available_nonnegative", sql`${table.availableBalance} >= 0`),
    check("wallet_locked_nonnegative", sql`${table.lockedBalance} >= 0`),
    check("wallet_pending_nonnegative", sql`${table.pendingBalance} >= 0`),
  ],
);

export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    type: walletTxTypeEnum("type").notNull(),
    direction: walletDirectionEnum("direction").notNull(),
    amount: rupiah("amount").notNull(),
    availableBefore: rupiah("available_before").notNull(),
    availableAfter: rupiah("available_after").notNull(),
    lockedBefore: rupiah("locked_before").notNull(),
    lockedAfter: rupiah("locked_after").notNull(),
    pendingBefore: rupiah("pending_before").notNull(),
    pendingAfter: rupiah("pending_after").notNull(),
    referenceType: varchar("reference_type", { length: 40 }).notNull(),
    referenceId: uuid("reference_id"),
    description: text("description").notNull(),
    status: walletTxStatusEnum("status").notNull().default("SUCCESS"),
    idempotencyKey: varchar("idempotency_key", { length: 180 }).notNull(),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => walletTransactions.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("wallet_transactions_idempotency_unique").on(table.idempotencyKey),
    index("wallet_transactions_user_created_idx").on(table.userId, table.createdAt, table.id),
    index("wallet_transactions_reference_idx").on(table.referenceType, table.referenceId),
    check("wallet_transactions_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const walletReservations = pgTable(
  "wallet_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    participantId: uuid("participant_id").notNull().references(() => arisanParticipants.id, { onDelete: "restrict" }),
    periodId: uuid("period_id").notNull().references(() => arisanPeriods.id, { onDelete: "restrict" }),
    amount: rupiah("amount").notNull(),
    status: walletReservationStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    releasedAt: timestamp("released_at", { withTimezone: true, mode: "date" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("wallet_reservations_participant_unique").on(table.participantId),
    index("wallet_reservations_wallet_status_idx").on(table.walletId, table.status),
    index("wallet_reservations_user_status_idx").on(table.userId, table.status, table.createdAt),
    index("wallet_reservations_period_status_idx").on(table.periodId, table.status),
    check("wallet_reservations_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const topups = pgTable(
  "topups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    amount: rupiah("amount").notNull(),
    provider: varchar("provider", { length: 48 }).notNull(),
    providerReference: varchar("provider_reference", { length: 180 }),
    checkoutUrl: text("checkout_url"),
    idempotencyKey: varchar("idempotency_key", { length: 180 }).notNull(),
    status: topupStatusEnum("status").notNull().default("PENDING"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    paymentCreateAttempts: integer("payment_create_attempts").notNull().default(0),
    lastPaymentAttemptAt: timestamp("last_payment_attempt_at", { withTimezone: true, mode: "date" }),
    lastPaymentErrorCode: varchar("last_payment_error_code", { length: 80 }),
    lastPaymentErrorMessage: text("last_payment_error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("topups_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("topups_provider_reference_unique").on(table.providerReference),
    index("topups_user_created_idx").on(table.userId, table.createdAt, table.id),
    index("topups_status_expires_idx").on(table.status, table.expiresAt),
    check("topups_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    walletId: uuid("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    amount: rupiah("amount").notNull(),
    bankName: text("bank_name").notNull(),
    accountName: text("account_name").notNull(),
    accountNumber: text("account_number").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 180 }).notNull(),
    status: withdrawalStatusEnum("status").notNull().default("PENDING"),
    approvalStatus: withdrawalApprovalStatusEnum("approval_status").notNull().default("PENDING"),
    approvedBy: uuid("approved_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    approvalReason: text("approval_reason"),
    riskStatus: riskStatusEnum("risk_status").notNull().default("CLEAR"),
    riskScore: integer("risk_score").notNull().default(0),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "date" }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorMessage: text("last_error_message"),
    providerReference: varchar("provider_reference", { length: 180 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("withdrawals_idempotency_unique").on(table.idempotencyKey),
    index("withdrawals_user_created_idx").on(table.userId, table.createdAt, table.id),
    index("withdrawals_status_retry_idx").on(table.status, table.nextRetryAt),
    check("withdrawals_amount_positive", sql`${table.amount} > 0`),
  ],
);

export const arisanTypes = pgTable(
  "arisan_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").notNull().default(""),
    contributionAmount: rupiah("contribution_amount").notNull(),
    minimumParticipants: integer("minimum_participants").notNull().default(2),
    maximumParticipants: integer("maximum_participants").notNull(),
    cancellationDeadlineDays: integer("cancellation_deadline_days").notNull().default(2),
    drawingMethod: varchar("drawing_method", { length: 40 }).notNull().default("CSPRNG"),
    platformFeeBps: integer("platform_fee_bps").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("arisan_types_active_idx").on(table.active),
    check("arisan_type_contribution_positive", sql`${table.contributionAmount} > 0`),
    check("arisan_type_participants_valid", sql`${table.minimumParticipants} >= 2 AND ${table.maximumParticipants} >= ${table.minimumParticipants}`),
    check("arisan_type_cancellation_days_valid", sql`${table.cancellationDeadlineDays} >= 0`),
    check("arisan_type_fee_valid", sql`${table.platformFeeBps} >= 0 AND ${table.platformFeeBps} <= 10000`),
  ],
);

export const arisanPeriods = pgTable(
  "arisan_periods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    typeId: uuid("type_id").notNull().references(() => arisanTypes.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 64 }).notNull(),
    registrationStartsAt: timestamp("registration_starts_at", { withTimezone: true, mode: "date" }).notNull(),
    registrationEndsAt: timestamp("registration_ends_at", { withTimezone: true, mode: "date" }).notNull(),
    drawingAt: timestamp("drawing_at", { withTimezone: true, mode: "date" }).notNull(),
    cancellationDeadlineAt: timestamp("cancellation_deadline_at", { withTimezone: true, mode: "date" }).notNull(),
    minimumParticipants: integer("minimum_participants").notNull(),
    maximumParticipants: integer("maximum_participants").notNull(),
    contributionAmount: rupiah("contribution_amount").notNull(),
    platformFeeBps: integer("platform_fee_bps").notNull().default(0),
    status: periodStatusEnum("status").notNull().default("DRAFT"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("arisan_periods_code_unique").on(table.code),
    index("arisan_periods_status_drawing_idx").on(table.status, table.drawingAt, table.id),
    check("arisan_period_dates_valid", sql`${table.registrationStartsAt} < ${table.registrationEndsAt} AND ${table.registrationEndsAt} <= ${table.drawingAt} AND ${table.cancellationDeadlineAt} < ${table.drawingAt}`),
    check("arisan_period_participants_valid", sql`${table.minimumParticipants} >= 2 AND ${table.maximumParticipants} >= ${table.minimumParticipants}`),
    check("arisan_period_contribution_positive", sql`${table.contributionAmount} > 0`),
  ],
);

export const arisanParticipants = pgTable(
  "arisan_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    periodId: uuid("period_id").notNull().references(() => arisanPeriods.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    contributionAmount: rupiah("contribution_amount").notNull(),
    status: participantStatusEnum("status").notNull().default("ACTIVE"),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    eligibleForDrawing: boolean("eligible_for_drawing").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("arisan_participants_period_user_unique").on(table.periodId, table.userId),
    index("arisan_participants_period_status_idx").on(table.periodId, table.status),
    index("arisan_participants_user_status_created_idx").on(table.userId, table.status, table.createdAt, table.id),
    index("arisan_participants_user_idx").on(table.userId, table.createdAt),
    check("arisan_participants_contribution_positive", sql`${table.contributionAmount} > 0`),
  ],
);

export const drawAuthorizations = pgTable(
  "draw_authorizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    periodId: uuid("period_id").notNull().references(() => arisanPeriods.id, { onDelete: "restrict" }),
    requestedBy: uuid("requested_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    executedAt: timestamp("executed_at", { withTimezone: true, mode: "date" }),
    status: drawAuthorizationStatusEnum("status").notNull().default("REQUESTED"),
    requestReason: text("request_reason").notNull(),
    approvalReason: text("approval_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("draw_authorizations_period_unique").on(table.periodId),
    index("draw_authorizations_status_idx").on(table.status, table.createdAt),
    check("draw_authorizations_checker_distinct", sql`${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.requestedBy}`),
  ],
);

export const drawings = pgTable(
  "drawings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    periodId: uuid("period_id").notNull().references(() => arisanPeriods.id, { onDelete: "restrict" }),
    selectionMethod: varchar("selection_method", { length: 40 }).notNull().default("NODE_CRYPTO_RANDOM_INT"),
    eligibleParticipantCount: integer("eligible_participant_count").notNull(),
    selectedParticipantId: uuid("selected_participant_id").notNull().references(() => arisanParticipants.id, { onDelete: "restrict" }),
    randomReference: varchar("random_reference", { length: 180 }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    executedBy: uuid("executed_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    status: varchar("status", { length: 24 }).notNull().default("SUCCESS"),
  },
  (table) => [uniqueIndex("drawings_period_unique").on(table.periodId), index("drawings_executed_at_idx").on(table.executedAt)],
);

export const winners = pgTable(
  "winners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    periodId: uuid("period_id").notNull().references(() => arisanPeriods.id, { onDelete: "restrict" }),
    participantId: uuid("participant_id").notNull().references(() => arisanParticipants.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    prizeAmount: rupiah("prize_amount").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("winners_period_unique").on(table.periodId), uniqueIndex("winners_participant_unique").on(table.participantId)],
);

export const payouts = pgTable(
  "payouts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    periodId: uuid("period_id").notNull().references(() => arisanPeriods.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    grossAmount: rupiah("gross_amount").notNull(),
    feeAmount: rupiah("fee_amount").notNull().default(0),
    netAmount: rupiah("net_amount").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 180 }).notNull(),
    status: payoutStatusEnum("status").notNull().default("PENDING"),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "date" }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorMessage: text("last_error_message"),
    providerReference: varchar("provider_reference", { length: 180 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("payouts_period_unique").on(table.periodId),
    uniqueIndex("payouts_idempotency_unique").on(table.idempotencyKey),
    check("payouts_amounts_valid", sql`${table.grossAmount} > 0 AND ${table.feeAmount} >= 0 AND ${table.netAmount} >= 0 AND ${table.grossAmount} = ${table.feeAmount} + ${table.netAmount}`),
  ],
);

export const withdrawalAttempts = pgTable(
  "withdrawal_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    withdrawalId: uuid("withdrawal_id").notNull().references(() => withdrawals.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    fromStatus: withdrawalStatusEnum("from_status").notNull(),
    toStatus: withdrawalStatusEnum("to_status").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 220 }).notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    providerReference: varchar("provider_reference", { length: 180 }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("withdrawal_attempts_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("withdrawal_attempts_transition_unique").on(table.withdrawalId, table.attemptNumber, table.toStatus),
    index("withdrawal_attempts_withdrawal_created_idx").on(table.withdrawalId, table.createdAt),
  ],
);

export const payoutAttempts = pgTable(
  "payout_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    payoutId: uuid("payout_id").notNull().references(() => payouts.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    fromStatus: payoutStatusEnum("from_status").notNull(),
    toStatus: payoutStatusEnum("to_status").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 220 }).notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    providerReference: varchar("provider_reference", { length: 180 }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("payout_attempts_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("payout_attempts_transition_unique").on(table.payoutId, table.attemptNumber, table.toStatus),
    index("payout_attempts_payout_created_idx").on(table.payoutId, table.createdAt),
  ],
);

export const financialAccounts = pgTable(
  "financial_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 180 }).notNull(),
    type: financialAccountTypeEnum("type").notNull(),
    periodId: uuid("period_id").references(() => arisanPeriods.id, { onDelete: "restrict" }),
    balance: rupiah("balance").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("financial_accounts_code_unique").on(table.code),
    uniqueIndex("financial_accounts_period_unique").on(table.periodId),
    check("financial_accounts_balance_nonnegative", sql`${table.balance} >= 0`),
  ],
);

export const financialTransactions = pgTable(
  "financial_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id").notNull().references(() => financialAccounts.id, { onDelete: "restrict" }),
    direction: financialDirectionEnum("direction").notNull(),
    amount: rupiah("amount").notNull(),
    balanceBefore: rupiah("balance_before").notNull(),
    balanceAfter: rupiah("balance_after").notNull(),
    referenceType: varchar("reference_type", { length: 60 }).notNull(),
    referenceId: uuid("reference_id"),
    description: text("description").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 180 }).notNull(),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => financialTransactions.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("financial_transactions_idempotency_unique").on(table.idempotencyKey),
    index("financial_transactions_account_created_idx").on(table.accountId, table.createdAt, table.id),
    index("financial_transactions_reference_idx").on(table.referenceType, table.referenceId),
    check("financial_transactions_amount_positive", sql`${table.amount} > 0`),
    check("financial_transactions_balance_nonnegative", sql`${table.balanceBefore} >= 0 AND ${table.balanceAfter} >= 0`),
  ],
);

export const platformFees = pgTable(
  "platform_fees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    periodId: uuid("period_id").notNull().references(() => arisanPeriods.id, { onDelete: "restrict" }),
    amount: rupiah("amount").notNull(),
    payoutId: uuid("payout_id").notNull().references(() => payouts.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("platform_fees_period_unique").on(table.periodId), check("platform_fees_amount_nonnegative", sql`${table.amount} >= 0`)],
);

export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    status: reconciliationRunStatusEnum("status").notNull(),
    scope: varchar("scope", { length: 32 }).notNull().default("GLOBAL"),
    periodId: uuid("period_id").references(() => arisanPeriods.id, { onDelete: "restrict" }),
    issueCount: integer("issue_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [index("reconciliation_runs_created_idx").on(table.createdAt), index("reconciliation_runs_period_idx").on(table.periodId)],
);

export const reconciliationIssues = pgTable(
  "reconciliation_issues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").notNull().references(() => reconciliationRuns.id, { onDelete: "cascade" }),
    severity: varchar("severity", { length: 16 }).notNull().default("CRITICAL"),
    code: varchar("code", { length: 80 }).notNull(),
    entityType: varchar("entity_type", { length: 60 }).notNull(),
    entityId: uuid("entity_id"),
    expectedValue: jsonb("expected_value"),
    actualValue: jsonb("actual_value"),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("reconciliation_issues_run_idx").on(table.runId), index("reconciliation_issues_code_idx").on(table.code)],
);

export const jobExecutions = pgTable(
  "job_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobKey: varchar("job_key", { length: 120 }).notNull(),
    status: jobStatusEnum("status").notNull().default("RUNNING"),
    leaseToken: varchar("lease_token", { length: 120 }),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: "date" }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorMessage: text("last_error_message"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("job_executions_job_key_unique").on(table.jobKey),
    index("job_executions_due_idx").on(table.status, table.nextRunAt),
    index("job_executions_lock_idx").on(table.status, table.lockedUntil),
    check("job_executions_attempts_valid", sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} > 0`),
  ],
);

export const complianceFlags = pgTable(
  "compliance_flags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    withdrawalId: uuid("withdrawal_id").references(() => withdrawals.id, { onDelete: "restrict" }),
    ruleCode: varchar("rule_code", { length: 80 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    status: complianceFlagStatusEnum("status").notNull().default("OPEN"),
    score: integer("score").notNull().default(0),
    reason: text("reason").notNull(),
    resolvedBy: uuid("resolved_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [index("compliance_flags_user_status_idx").on(table.userId, table.status),
    index("compliance_flags_status_created_idx").on(table.status, table.createdAt, table.id), index("compliance_flags_withdrawal_idx").on(table.withdrawalId), check("compliance_flags_score_valid", sql`${table.score} >= 0`)],
);


export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    type: privacyRequestTypeEnum("type").notNull(),
    status: privacyRequestStatusEnum("status").notNull().default("PENDING"),
    reason: text("reason"),
    processedBy: uuid("processed_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("privacy_requests_user_created_idx").on(table.userId, table.createdAt, table.id), index("privacy_requests_status_created_idx").on(table.status, table.createdAt, table.id)],
);

export const privacyConsents = pgTable(
  "privacy_consents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    policyType: varchar("policy_type", { length: 40 }).notNull(),
    policyVersion: varchar("policy_version", { length: 40 }).notNull(),
    granted: boolean("granted").notNull(),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
  },
  (table) => [index("privacy_consents_user_policy_idx").on(table.userId, table.policyType, table.grantedAt, table.id)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 140 }).notNull(),
    message: text("message").notNull(),
    type: varchar("type", { length: 40 }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }),
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: uuid("reference_id"),
    createdAt: createdAt(),
  },
  (table) => [
    index("notifications_user_created_idx").on(table.userId, table.createdAt, table.id),
    index("notifications_user_unread_created_idx").on(table.userId, table.readAt, table.createdAt, table.id),
    uniqueIndex("notifications_user_type_reference_unique").on(table.userId, table.type, table.referenceId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sequenceNo: bigint("sequence_no", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    prevHash: varchar("prev_hash", { length: 64 }),
    entryHash: varchar("entry_hash", { length: 64 }).notNull().default(""),
    actorId: uuid("actor_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    actorType: varchar("actor_type", { length: 32 }).notNull(),
    action: varchar("action", { length: 100 }).notNull(),
    entityType: varchar("entity_type", { length: 60 }).notNull(),
    entityId: uuid("entity_id"),
    oldValue: jsonb("old_value").$type<Record<string, unknown> | null>(),
    newValue: jsonb("new_value").$type<Record<string, unknown> | null>(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("audit_logs_sequence_unique").on(table.sequenceNo), uniqueIndex("audit_logs_entry_hash_unique").on(table.entryHash), index("audit_logs_actor_created_idx").on(table.actorId, table.createdAt, table.id),
    index("audit_logs_entity_created_idx").on(table.entityType, table.entityId, table.createdAt, table.id), index("audit_logs_entity_idx").on(table.entityType, table.entityId)],
);

export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 48 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 180 }).notNull(),
    topupId: uuid("topup_id").references(() => topups.id, { onDelete: "restrict" }),
    receivedAt: createdAt(),
    signatureTimestamp: varchar("signature_timestamp", { length: 32 }),
    payloadHash: varchar("payload_hash", { length: 64 }),
  },
  (table) => [
    uniqueIndex("payment_webhook_provider_event_unique").on(table.provider, table.providerEventId),
    index("payment_webhook_topup_idx").on(table.topupId),
  ],
);

export const domainEventOutbox = pgTable(
  "domain_event_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    eventVersion: integer("event_version").notNull().default(1),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    lastErrorMessage: text("last_error_message"),
    createdAt: createdAt(),
  },
  (table) => [
    index("domain_event_outbox_pending_idx").on(table.publishedAt, table.nextAttemptAt, table.occurredAt, table.id),
    index("domain_event_outbox_aggregate_idx").on(table.aggregateType, table.aggregateId, table.occurredAt, table.id),
    check("domain_event_outbox_version_valid", sql`${table.eventVersion} > 0`),
    check("domain_event_outbox_attempts_valid", sql`${table.attemptCount} >= 0`),
  ],
);

export const arisanPeriodReadModels = pgTable(
  "arisan_period_read_models",
  {
    periodId: uuid("period_id").primaryKey().references(() => arisanPeriods.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 64 }).notNull(),
    typeName: varchar("type_name", { length: 160 }).notNull(),
    description: text("description"),
    contributionAmount: rupiah("contribution_amount").notNull(),
    minimumParticipants: integer("minimum_participants").notNull(),
    maximumParticipants: integer("maximum_participants").notNull(),
    registrationStartsAt: timestamp("registration_starts_at", { withTimezone: true, mode: "date" }).notNull(),
    registrationEndsAt: timestamp("registration_ends_at", { withTimezone: true, mode: "date" }).notNull(),
    drawingAt: timestamp("drawing_at", { withTimezone: true, mode: "date" }).notNull(),
    cancellationDeadlineAt: timestamp("cancellation_deadline_at", { withTimezone: true, mode: "date" }).notNull(),
    status: periodStatusEnum("status").notNull(),
    activeParticipantCount: integer("active_participant_count").notNull().default(0),
    projectionVersion: integer("projection_version").notNull().default(1),
    projectedAt: timestamp("projected_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("arisan_period_read_models_listing_idx").on(table.status, table.drawingAt, table.periodId),
    check("arisan_period_read_models_count_valid", sql`${table.activeParticipantCount} >= 0`),
  ],
);
