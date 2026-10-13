import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, notifications, payoutAttempts, payouts, users, withdrawalAttempts, withdrawals, wallets, walletTransactions } from "@/db/schema";
import { ApiError } from "@/server/http";
import { assertDisbursementEvidence, getPayoutProvider, stablePayoutReference, type DisbursementResult } from "@/server/services/payout-provider";
import { decryptBankPii } from "@/server/services/pii";
import { isWithdrawalRetryDue, MAX_WITHDRAWAL_ATTEMPTS, resolveWithdrawalFailure } from "@/server/services/withdrawal-policy";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Meta = { ipAddress?: string | null; userAgent?: string | null };
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

function financialWithdrawalView(withdrawal: {
  id: string; amount: number; status: string; approvalStatus: string; riskStatus: string;
  approvedBy?: string | null; approvedAt?: Date | null; attemptCount?: number; nextRetryAt?: Date | null;
  providerReference?: string | null;
}) {
  return {
    id: withdrawal.id, amount: withdrawal.amount, status: withdrawal.status,
    approvalStatus: withdrawal.approvalStatus, riskStatus: withdrawal.riskStatus,
    approvedBy: withdrawal.approvedBy ?? null, approvedAt: withdrawal.approvedAt ?? null,
    attemptCount: withdrawal.attemptCount ?? 0, nextRetryAt: withdrawal.nextRetryAt ?? null,
    providerReference: withdrawal.providerReference ?? null,
  };
}

function retryAt(attempt: number): Date {
  return new Date(Date.now() + RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)]);
}

async function assertAdministrator(tx: Transaction, adminId: string | undefined) {
  if (!adminId) throw new ApiError("Administrator tidak ditemukan.", "ADMIN_ACTOR_REQUIRED", 403);
  const [admin] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, adminId)).limit(1);
  if (!admin || admin.status !== "ACTIVE" || !["ADMIN", "SUPER_ADMIN"].includes(admin.role)) {
    throw new ApiError("Akses administrator aktif diperlukan.", "FORBIDDEN", 403);
  }
}

function assertMakerChecker(withdrawal: typeof withdrawals.$inferSelect, adminId: string | undefined) {
  if (withdrawal.approvalStatus !== "APPROVED") throw new ApiError("Withdrawal harus di-approve oleh maker yang berbeda sebelum diproses.", "WITHDRAWAL_APPROVAL_REQUIRED", 409);
  if (withdrawal.userId === adminId) throw new ApiError("Administrator tidak boleh mengeksekusi withdrawal miliknya sendiri.", "WITHDRAWAL_SELF_EXECUTION_BLOCKED", 403);
  if (withdrawal.approvedBy === adminId) throw new ApiError("Maker dan checker harus merupakan administrator yang berbeda.", "MAKER_CHECKER_SEPARATION_REQUIRED", 403);
  if (withdrawal.riskStatus !== "CLEAR") throw new ApiError("Withdrawal masih berada dalam review risiko.", "WITHDRAWAL_RISK_REVIEW_REQUIRED", 409);
}

async function persistWithdrawalProviderReference(input: { withdrawalId: string; attemptCount: number; evidence: DisbursementResult }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`);
    const [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, input.withdrawalId)).limit(1);
    if (!withdrawal) throw new ApiError("Withdrawal tidak ditemukan.", "WITHDRAWAL_NOT_FOUND", 404);
    assertDisbursementEvidence(input.evidence, { reference: stablePayoutReference(withdrawal.id), amount: withdrawal.amount, provider: withdrawal.provider, providerReference: withdrawal.providerReference });
    if (withdrawal.attemptCount !== input.attemptCount) throw new ApiError("Respons provider berasal dari attempt lama.", "WITHDRAWAL_STALE_ATTEMPT", 409);
    if (withdrawal.status !== "PROCESSING") return { ...financialWithdrawalView(withdrawal), replayed: true };
    await tx.update(withdrawals).set({ providerReference: input.evidence.providerReference, provider: input.evidence.provider, lastProviderEvidence: input.evidence, updatedAt: new Date() }).where(eq(withdrawals.id, withdrawal.id));
    await tx.update(withdrawalAttempts).set({ providerReference: input.evidence.providerReference, providerEvidence: input.evidence }).where(and(
      eq(withdrawalAttempts.withdrawalId, withdrawal.id), eq(withdrawalAttempts.attemptNumber, input.attemptCount), eq(withdrawalAttempts.toStatus, "PROCESSING"),
    ));
    await tx.insert(auditLogs).values({ actorType: "SYSTEM", action: "WITHDRAWAL_PROVIDER_OBSERVED", entityType: "withdrawal", entityId: withdrawal.id, newValue: { attemptCount: input.attemptCount, evidence: input.evidence } });
    return { id: withdrawal.id, status: "PROCESSING" as const, replayed: false, providerStatus: input.evidence.status };
  });
}

export async function processWithdrawal(input: {
  withdrawalId: string;
  decision: "PROCESSING" | "SUCCESS" | "FAILED_RETRYABLE" | "FAILED_FINAL";
  adminId?: string;
  adminRole: "ADMIN" | "SUPER_ADMIN" | "SYSTEM";
  meta?: Meta;
  source?: "ADMIN" | "PROVIDER";
  providerEvidence?: DisbursementResult;
  expectedAttemptCount?: number;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`);
    const [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, input.withdrawalId)).limit(1);
    if (!withdrawal) throw new ApiError("Withdrawal tidak ditemukan.", "WITHDRAWAL_NOT_FOUND", 404);

    if (input.decision !== "PROCESSING" && input.source !== "PROVIDER") {
      throw new ApiError("SUCCESS/FAILED hanya dapat ditetapkan berdasarkan konfirmasi payout provider.", "WITHDRAWAL_PROVIDER_CONFIRMATION_REQUIRED", 409);
    }
    let evidence: DisbursementResult | undefined;
    if (input.source === "PROVIDER") {
      if (input.decision === "PROCESSING") throw new ApiError("Provider tidak dapat memulai attempt lokal.", "INVALID_WITHDRAWAL_TRANSITION", 409);
      assertDisbursementEvidence(input.providerEvidence, { reference: stablePayoutReference(withdrawal.id), amount: withdrawal.amount, provider: withdrawal.provider, providerReference: withdrawal.providerReference });
      evidence = input.providerEvidence;
      if (evidence.status !== input.decision) throw new ApiError("Keputusan tidak sesuai dengan bukti provider.", "PAYOUT_EVIDENCE_STATUS_MISMATCH", 409);
      if (input.expectedAttemptCount === undefined || withdrawal.attemptCount !== input.expectedAttemptCount) {
        throw new ApiError("Respons provider berasal dari attempt lama atau tidak memiliki fencing token.", "WITHDRAWAL_STALE_ATTEMPT", 409);
      }
    } else {
      await assertAdministrator(tx, input.adminId);
      assertMakerChecker(withdrawal, input.adminId);
    }
    // Authorization and evidence are checked BEFORE terminal replay. A source flag alone is not evidence.
    if (withdrawal.status === input.decision) return { id: withdrawal.id, status: withdrawal.status, replayed: true, attemptCount: withdrawal.attemptCount };
    if (["SUCCESS", "FAILED_FINAL", "CANCELLED"].includes(withdrawal.status)) {
      throw new ApiError("Withdrawal sudah berada pada terminal state.", "WITHDRAWAL_TERMINAL", 409);
    }
    const now = new Date();
    if (input.decision === "PROCESSING") {
      if (withdrawal.status !== "PENDING" && withdrawal.status !== "FAILED_RETRYABLE") throw new ApiError("Withdrawal tidak dapat masuk PROCESSING dari state saat ini.", "INVALID_WITHDRAWAL_TRANSITION", 409);
      if (withdrawal.status === "FAILED_RETRYABLE" && !isWithdrawalRetryDue(withdrawal.nextRetryAt, now)) throw new ApiError("Retry withdrawal belum jatuh tempo.", "WITHDRAWAL_RETRY_NOT_DUE", 409);
      if (withdrawal.attemptCount >= MAX_WITHDRAWAL_ATTEMPTS) throw new ApiError("Batas percobaan withdrawal telah tercapai.", "WITHDRAWAL_MAX_ATTEMPTS", 409);
      const attemptNumber = withdrawal.attemptCount + 1;
      const provider = getPayoutProvider(withdrawal.provider);
      await tx.update(withdrawals).set({ provider: provider.name, status: "PROCESSING", attemptCount: attemptNumber, nextRetryAt: null, lastErrorCode: null, lastErrorMessage: null, updatedAt: now }).where(eq(withdrawals.id, withdrawal.id));
      await tx.insert(withdrawalAttempts).values({ withdrawalId: withdrawal.id, attemptNumber, fromStatus: withdrawal.status, toStatus: "PROCESSING", idempotencyKey: `WITHDRAWAL-ATTEMPT-${withdrawal.id}-${attemptNumber}-PROCESSING` });
      await tx.insert(auditLogs).values({ actorId: input.adminId ?? null, actorType: input.adminRole, action: "WITHDRAWAL_PROCESSING", entityType: "withdrawal", entityId: withdrawal.id, oldValue: { status: withdrawal.status }, newValue: { status: "PROCESSING", attemptCount: attemptNumber }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
      return { id: withdrawal.id, status: "PROCESSING" as const, replayed: false, attemptCount: attemptNumber };
    }
    if (withdrawal.status !== "PROCESSING" && !(withdrawal.status === "FAILED_RETRYABLE" && input.decision === "SUCCESS")) {
      throw new ApiError("Withdrawal harus PROCESSING sebelum diselesaikan.", "INVALID_WITHDRAWAL_TRANSITION", 409);
    }
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${withdrawal.walletId} FOR UPDATE`);
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, withdrawal.walletId)).limit(1);
    if (!wallet || wallet.pendingBalance < withdrawal.amount) throw new ApiError("Saldo pending tidak sesuai dengan withdrawal.", "WALLET_INTEGRITY_ERROR", 500);

    const isSuccess = input.decision === "SUCCESS";
    const terminalFailure = input.decision === "FAILED_FINAL";
    const outcome = resolveWithdrawalFailure({ decision: input.decision, attemptCount: withdrawal.attemptCount, maxAttempts: MAX_WITHDRAWAL_ATTEMPTS, failureConfirmed: evidence?.failureConfirmed });
    const finalStatus = outcome.status;
    const nextRetryAt = finalStatus === "FAILED_RETRYABLE" ? retryAt(withdrawal.attemptCount) : null;
    const terminalOutcome = isSuccess || finalStatus === "FAILED_FINAL";
    const shouldRefundFunds = terminalFailure || finalStatus === "FAILED_FINAL";
    const pendingRelease = terminalOutcome ? withdrawal.amount : 0;
    const pendingAfter = wallet.pendingBalance - pendingRelease;
    const availableAfter = shouldRefundFunds ? wallet.availableBalance + withdrawal.amount : wallet.availableBalance;
    const totalBefore = wallet.availableBalance + wallet.lockedBalance + wallet.pendingBalance;
    const totalAfter = availableAfter + wallet.lockedBalance + pendingAfter;
    if (pendingAfter < 0 || totalAfter !== totalBefore - (isSuccess ? withdrawal.amount : 0)) throw new ApiError("Accounting wallet tidak konsisten saat menyelesaikan withdrawal.", "WALLET_ACCOUNTING_MISMATCH", 500);

    await tx.update(wallets).set({ availableBalance: availableAfter, pendingBalance: pendingAfter, updatedAt: now }).where(eq(wallets.id, wallet.id));
    const { errorCode, errorMessage } = outcome;
    await tx.update(withdrawals).set({ status: finalStatus, processedAt: terminalOutcome ? now : null, nextRetryAt, lastErrorCode: errorCode, lastErrorMessage: errorMessage, provider: evidence!.provider, providerReference: evidence!.providerReference, lastProviderEvidence: evidence!, updatedAt: now }).where(eq(withdrawals.id, withdrawal.id));
    await tx.insert(withdrawalAttempts).values({ withdrawalId: withdrawal.id, attemptNumber: withdrawal.attemptCount, fromStatus: withdrawal.status, toStatus: finalStatus, idempotencyKey: `WITHDRAWAL-ATTEMPT-${withdrawal.id}-${withdrawal.attemptCount}-${finalStatus}`, errorCode, errorMessage, providerReference: evidence!.providerReference, providerEvidence: evidence!, nextRetryAt });
    if (terminalOutcome) {
      await tx.insert(walletTransactions).values({
        walletId: wallet.id, userId: withdrawal.userId, type: isSuccess ? "WITHDRAW" : "REFUND", direction: isSuccess ? "DEBIT" : "CREDIT", amount: withdrawal.amount,
        availableBefore: wallet.availableBalance, availableAfter, lockedBefore: wallet.lockedBalance, lockedAfter: wallet.lockedBalance, pendingBefore: wallet.pendingBalance, pendingAfter,
        referenceType: "withdrawal", referenceId: withdrawal.id, description: isSuccess ? "Withdrawal berhasil dikirim" : "Pengembalian dana withdrawal gagal terkonfirmasi",
        idempotencyKey: `WITHDRAWAL-${withdrawal.id}-${finalStatus}`,
      });
    }
    await tx.insert(notifications).values({ userId: withdrawal.userId, title: isSuccess ? "Withdrawal berhasil" : finalStatus === "FAILED_RETRYABLE" ? "Withdrawal sedang dicoba kembali" : "Withdrawal gagal", message: isSuccess ? `Withdrawal ${withdrawal.amount.toLocaleString("id-ID")} telah diproses.` : finalStatus === "FAILED_RETRYABLE" ? `Transfer gagal terkonfirmasi; retry dapat dilakukan setelah ${nextRetryAt?.toISOString()}.` : `Dana ${withdrawal.amount.toLocaleString("id-ID")} telah dikembalikan setelah kegagalan transfer dikonfirmasi provider.`, type: isSuccess ? "WITHDRAWAL_SUCCESS" : finalStatus === "FAILED_RETRYABLE" ? "WITHDRAWAL_RETRYABLE" : "WITHDRAWAL_FAILED", referenceType: "withdrawal", referenceId: withdrawal.id }).onConflictDoNothing();
    await tx.insert(auditLogs).values({ actorId: input.adminId ?? null, actorType: input.adminRole, action: isSuccess ? "WITHDRAWAL_SUCCEEDED" : finalStatus === "FAILED_RETRYABLE" ? "WITHDRAWAL_FAILED_RETRYABLE" : "WITHDRAWAL_FAILED_FINAL", entityType: "withdrawal", entityId: withdrawal.id, oldValue: { status: withdrawal.status }, newValue: { status: finalStatus, attemptCount: withdrawal.attemptCount, nextRetryAt, evidence }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
    return { id: withdrawal.id, status: finalStatus, replayed: false, attemptCount: withdrawal.attemptCount, nextRetryAt };
  });
}

// Internal arisan payouts settle to a wallet, not an external bank transfer.
export async function markPayoutRetryable(input: { payoutId: string; errorCode: string; errorMessage: string; providerReference?: string | null }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM payouts WHERE id = ${input.payoutId} FOR UPDATE`);
    const [payout] = await tx.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1);
    if (!payout) throw new ApiError("Payout tidak ditemukan.", "PAYOUT_NOT_FOUND", 404);
    if (payout.status !== "PROCESSING") throw new ApiError("Payout harus PROCESSING sebelum ditandai retryable.", "INVALID_PAYOUT_TRANSITION", 409);
    const nextRetryAt = retryAt(Math.max(payout.attemptCount, 1));
    await tx.update(payouts).set({ status: "FAILED_RETRYABLE", nextRetryAt, lastErrorCode: input.errorCode, lastErrorMessage: input.errorMessage, providerReference: input.providerReference ?? payout.providerReference, updatedAt: new Date() }).where(eq(payouts.id, payout.id));
    await tx.insert(payoutAttempts).values({ payoutId: payout.id, attemptNumber: payout.attemptCount, fromStatus: "PROCESSING", toStatus: "FAILED_RETRYABLE", idempotencyKey: `PAYOUT-ATTEMPT-${payout.id}-${payout.attemptCount}-FAILED_RETRYABLE`, errorCode: input.errorCode, errorMessage: input.errorMessage, providerReference: input.providerReference ?? null, nextRetryAt });
    return { payoutId: payout.id, status: "FAILED_RETRYABLE" as const, nextRetryAt };
  });
}

export async function retryPayout(input: { payoutId: string }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM payouts WHERE id = ${input.payoutId} FOR UPDATE`);
    const [payout] = await tx.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1);
    if (!payout) throw new ApiError("Payout tidak ditemukan.", "PAYOUT_NOT_FOUND", 404);
    if (payout.status !== "FAILED_RETRYABLE") throw new ApiError("Payout tidak berada pada state retryable.", "INVALID_PAYOUT_RETRY", 409);
    if (!isWithdrawalRetryDue(payout.nextRetryAt, new Date())) throw new ApiError("Retry payout belum jatuh tempo.", "PAYOUT_RETRY_NOT_DUE", 409);
    if (payout.attemptCount >= MAX_WITHDRAWAL_ATTEMPTS) throw new ApiError("Batas percobaan payout telah tercapai; perlu review.", "PAYOUT_MAX_ATTEMPTS", 409);
    const attemptNumber = payout.attemptCount + 1;
    await tx.update(payouts).set({ status: "PROCESSING", attemptCount: attemptNumber, nextRetryAt: null, lastErrorCode: null, lastErrorMessage: null, updatedAt: new Date() }).where(eq(payouts.id, payout.id));
    await tx.insert(payoutAttempts).values({ payoutId: payout.id, attemptNumber, fromStatus: "FAILED_RETRYABLE", toStatus: "PROCESSING", idempotencyKey: `PAYOUT-ATTEMPT-${payout.id}-${attemptNumber}-PROCESSING` });
    return { payoutId: payout.id, status: "PROCESSING" as const, attemptNumber };
  });
}

export async function executeWithdrawal(input: { withdrawalId: string; adminId: string; adminRole: "ADMIN" | "SUPER_ADMIN"; meta?: Meta; retryOnly?: boolean }) {
  const provider = getPayoutProvider();
  const started = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`);
    const [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, input.withdrawalId)).limit(1);
    if (!withdrawal) throw new ApiError("Withdrawal tidak ditemukan.", "WITHDRAWAL_NOT_FOUND", 404);
    await assertAdministrator(tx, input.adminId);
    if (withdrawal.provider && withdrawal.provider !== provider.name) throw new ApiError("Provider withdrawal berbeda dari konfigurasi aktif.", "PAYOUT_PROVIDER_CONFIG_MISMATCH", 503);
    if (withdrawal.status === "SUCCESS") {
      if (!withdrawal.provider || !withdrawal.providerReference?.trim() || !withdrawal.lastProviderEvidence || withdrawal.lastProviderEvidence.status !== "SUCCESS") throw new ApiError("Withdrawal legacy SUCCESS belum memiliki bukti provider; perlu investigasi read-only.", "WITHDRAWAL_EVIDENCE_MISSING", 409);
      assertDisbursementEvidence(withdrawal.lastProviderEvidence as unknown as DisbursementResult, { reference: stablePayoutReference(withdrawal.id), amount: withdrawal.amount, provider: withdrawal.provider, providerReference: withdrawal.providerReference });
      return { withdrawal, replayed: true, needsCreate: false, retry: false };
    }
    if (withdrawal.status === "PROCESSING" && !withdrawal.provider) throw new ApiError("Provider withdrawal legacy belum diketahui; perlu investigasi sebelum inquiry/retry.", "PAYOUT_PROVIDER_IDENTITY_REQUIRED", 409);
    assertMakerChecker(withdrawal, input.adminId);
    if (withdrawal.status === "FAILED_FINAL" || withdrawal.status === "CANCELLED") throw new ApiError("Withdrawal sudah berada pada terminal state.", "WITHDRAWAL_TERMINAL", 409);
    if (input.retryOnly && withdrawal.status !== "FAILED_RETRYABLE" && withdrawal.status !== "PROCESSING") throw new ApiError("Withdrawal tidak berada pada state retryable.", "INVALID_WITHDRAWAL_TRANSITION", 409);
    const now = new Date();
    if (withdrawal.status === "FAILED_RETRYABLE" && !isWithdrawalRetryDue(withdrawal.nextRetryAt, now)) throw new ApiError("Retry withdrawal belum jatuh tempo.", "WITHDRAWAL_RETRY_NOT_DUE", 409);
    if (withdrawal.status === "PENDING" || withdrawal.status === "FAILED_RETRYABLE") {
      const [beneficiary] = await tx.select({ status: users.status, kycStatus: users.kycStatus }).from(users).where(eq(users.id, withdrawal.userId)).for("share").limit(1);
      if (!beneficiary || beneficiary.status !== "ACTIVE" || beneficiary.kycStatus !== "VERIFIED") throw new ApiError("Penerima withdrawal tidak aktif atau KYC tidak lagi terverifikasi.", "WITHDRAWAL_BENEFICIARY_INELIGIBLE", 403);
      if (withdrawal.attemptCount >= MAX_WITHDRAWAL_ATTEMPTS) throw new ApiError("Batas percobaan withdrawal telah tercapai.", "WITHDRAWAL_MAX_ATTEMPTS", 409);
      const attemptNumber = withdrawal.attemptCount + 1;
      await tx.update(withdrawals).set({ status: "PROCESSING", provider: provider.name, attemptCount: attemptNumber, nextRetryAt: null, lastErrorCode: null, lastErrorMessage: null, updatedAt: now }).where(eq(withdrawals.id, withdrawal.id));
      await tx.insert(withdrawalAttempts).values({ withdrawalId: withdrawal.id, attemptNumber, fromStatus: withdrawal.status, toStatus: "PROCESSING", idempotencyKey: `WITHDRAWAL-ATTEMPT-${withdrawal.id}-${attemptNumber}-PROCESSING` });
      await tx.insert(auditLogs).values({ actorId: input.adminId, actorType: input.adminRole, action: "WITHDRAWAL_PROCESSING", entityType: "withdrawal", entityId: withdrawal.id, oldValue: { status: withdrawal.status }, newValue: { status: "PROCESSING", attemptCount: attemptNumber, provider: provider.name }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
      return { withdrawal: { ...withdrawal, provider: provider.name, status: "PROCESSING" as const, attemptCount: attemptNumber }, replayed: false, needsCreate: true, retry: withdrawal.status === "FAILED_RETRYABLE" };
    }
    return { withdrawal, replayed: false, needsCreate: false, retry: false };
  });
  if (started.replayed) return { withdrawal: financialWithdrawalView(started.withdrawal), id: started.withdrawal.id, status: "SUCCESS" as const, replayed: true, providerStatus: "NOT_CHECKED" as const };
  const w = started.withdrawal;
  const reference = stablePayoutReference(w.id);
  const handleProviderResult = async (result: DisbursementResult) => {
    if (result.status === "UNKNOWN") return { id: w.id, status: "PROCESSING" as const, replayed: false, providerStatus: "UNKNOWN" as const, requiresReconciliation: true };
    assertDisbursementEvidence(result, { reference, amount: w.amount, provider: provider.name, providerReference: w.providerReference });
    if (result.status === "PROCESSING") return persistWithdrawalProviderReference({ withdrawalId: w.id, attemptCount: w.attemptCount, evidence: result });
    return processWithdrawal({ withdrawalId: w.id, decision: result.status, adminId: input.adminId, adminRole: input.adminRole, meta: input.meta, source: "PROVIDER", providerEvidence: result, expectedAttemptCount: w.attemptCount });
  };
  if (!started.needsCreate || started.retry) {
    const status = await provider.getDisbursementStatus(reference);
    // A PROCESSING/404/unknown inquiry must NEVER trigger a new create request.
    if (!started.retry || status.status !== "FAILED_RETRYABLE") return handleProviderResult(status);
    assertDisbursementEvidence(status, { reference, amount: w.amount, provider: provider.name, providerReference: w.providerReference });
  }
  let result: DisbursementResult;
  try {
    result = await provider.createDisbursement({ reference, bankName: decryptBankPii(w.bankName), accountName: decryptBankPii(w.accountName), accountNumber: decryptBankPii(w.accountNumber), amount: w.amount });
  } catch {
    // Network rejection is ambiguous. Inquiry may prove an outcome, but never infer a refund from a timeout/404.
    const status = await provider.getDisbursementStatus(reference).catch(() => null);
    if (status && status.status !== "UNKNOWN") return handleProviderResult(status);
    throw new ApiError("Status payout tidak dapat dipastikan; withdrawal tetap PROCESSING untuk rekonsiliasi.", "PAYOUT_AMBIGUOUS", 502);
  }
  // Keep DB finalization outside the create catch: a DB failure is recovered by inquiry, not by re-submitting money.
  return handleProviderResult(result);
}
