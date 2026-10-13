import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, notifications, payoutAttempts, payouts, withdrawalAttempts, withdrawals, wallets, walletTransactions } from "@/db/schema";
import { ApiError } from "@/server/http";
import { getPayoutProvider, stablePayoutReference } from "@/server/services/payout-provider";
import { decryptBankPii } from "@/server/services/pii";
import { isWithdrawalRetryDue, resolveWithdrawalFailure } from "@/server/services/withdrawal-policy";

const MAX_WITHDRAWAL_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

function financialWithdrawalView(withdrawal: {
  id: string; amount: number; status: string; approvalStatus: string; riskStatus: string;
  approvedBy?: string | null; approvedAt?: Date | null; attemptCount?: number; nextRetryAt?: Date | null;
}) {
  return {
    id: withdrawal.id,
    amount: withdrawal.amount,
    status: withdrawal.status,
    approvalStatus: withdrawal.approvalStatus,
    riskStatus: withdrawal.riskStatus,
    approvedBy: withdrawal.approvedBy ?? null,
    approvedAt: withdrawal.approvedAt ?? null,
    attemptCount: withdrawal.attemptCount ?? 0,
    nextRetryAt: withdrawal.nextRetryAt ?? null,
  };
}

function retryAt(attempt: number): Date {
  return new Date(Date.now() + RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)]);
}

async function persistWithdrawalProviderReference(input: { withdrawalId: string; attemptCount: number; providerReference: string | null }) {
  if (!input.providerReference) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`);
    await tx.update(withdrawals).set({ providerReference: input.providerReference, updatedAt: new Date() }).where(eq(withdrawals.id, input.withdrawalId));
    await tx.update(withdrawalAttempts).set({ providerReference: input.providerReference }).where(and(
      eq(withdrawalAttempts.withdrawalId, input.withdrawalId),
      eq(withdrawalAttempts.attemptNumber, input.attemptCount),
      eq(withdrawalAttempts.toStatus, "PROCESSING"),
    ));
  });
}

export async function processWithdrawal(input: {
  withdrawalId: string;
  decision: "PROCESSING" | "SUCCESS" | "FAILED_RETRYABLE" | "FAILED_FINAL";
  adminId?: string;
  adminRole: "ADMIN" | "SUPER_ADMIN" | "SYSTEM";
  meta?: { ipAddress?: string | null; userAgent?: string | null };
  source?: "ADMIN" | "PROVIDER";
  providerReference?: string | null;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`);
    const [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, input.withdrawalId)).limit(1);
    if (!withdrawal) throw new ApiError("Withdrawal tidak ditemukan.", "WITHDRAWAL_NOT_FOUND", 404);

    // Provider reconciliation may discover the provider reference only after the
    // external status lookup. Persist it under the same row lock as the final
    // state transition so concurrent reconcilers cannot race this metadata.
    const providerReference = input.source === "PROVIDER" ? input.providerReference?.trim() || null : null;
    if (providerReference && providerReference !== withdrawal.providerReference) {
      await tx.update(withdrawals).set({ providerReference, updatedAt: new Date() }).where(eq(withdrawals.id, withdrawal.id));
    }

    if (withdrawal.status === input.decision) {
      if (providerReference) {
        await tx.update(withdrawalAttempts).set({ providerReference }).where(and(
          eq(withdrawalAttempts.withdrawalId, withdrawal.id),
          eq(withdrawalAttempts.attemptNumber, withdrawal.attemptCount),
          eq(withdrawalAttempts.toStatus, withdrawal.status),
        ));
      }
      return { id: withdrawal.id, status: withdrawal.status, replayed: true, attemptCount: withdrawal.attemptCount };
    }
    if (withdrawal.status === "SUCCESS" || withdrawal.status === "FAILED_FINAL" || withdrawal.status === "CANCELLED") {
      throw new ApiError("Withdrawal sudah berada pada terminal state.", "WITHDRAWAL_TERMINAL", 409);
    }

    if (input.source !== "PROVIDER") {
      if (withdrawal.approvalStatus !== "APPROVED") throw new ApiError("Withdrawal harus di-approve oleh maker yang berbeda sebelum diproses.", "WITHDRAWAL_APPROVAL_REQUIRED", 409);
      if (!input.adminId) throw new ApiError("Administrator tidak ditemukan.", "ADMIN_ACTOR_REQUIRED", 500);
      if (withdrawal.approvedBy === input.adminId) throw new ApiError("Maker dan checker harus merupakan administrator yang berbeda.", "MAKER_CHECKER_SEPARATION_REQUIRED", 403);
      if (withdrawal.riskStatus !== "CLEAR") throw new ApiError("Withdrawal masih berada dalam review risiko.", "WITHDRAWAL_RISK_REVIEW_REQUIRED", 409);
    }
    const now = new Date();
    if (input.decision === "PROCESSING") {
      if (withdrawal.status !== "PENDING" && withdrawal.status !== "FAILED_RETRYABLE") {
        throw new ApiError("Withdrawal tidak dapat masuk PROCESSING dari state saat ini.", "INVALID_WITHDRAWAL_TRANSITION", 409);
      }
      if (withdrawal.status === "FAILED_RETRYABLE" && !isWithdrawalRetryDue(withdrawal.nextRetryAt, now)) {
        throw new ApiError("Retry withdrawal belum jatuh tempo.", "WITHDRAWAL_RETRY_NOT_DUE", 409);
      }
      if (withdrawal.attemptCount >= MAX_WITHDRAWAL_ATTEMPTS) {
        throw new ApiError("Batas percobaan withdrawal telah tercapai.", "WITHDRAWAL_MAX_ATTEMPTS", 409);
      }
      const attemptNumber = withdrawal.attemptCount + 1;
      await tx.update(withdrawals).set({ status: "PROCESSING", attemptCount: attemptNumber, nextRetryAt: null, lastErrorCode: null, lastErrorMessage: null, updatedAt: now }).where(eq(withdrawals.id, withdrawal.id));
      await tx.insert(withdrawalAttempts).values({
        withdrawalId: withdrawal.id, attemptNumber, fromStatus: withdrawal.status, toStatus: "PROCESSING",
        idempotencyKey: `WITHDRAWAL-ATTEMPT-${withdrawal.id}-${attemptNumber}-PROCESSING`,
      });
      await tx.insert(auditLogs).values({ actorId: input.adminId ?? null, actorType: input.adminRole, action: "WITHDRAWAL_PROCESSING", entityType: "withdrawal", entityId: withdrawal.id, oldValue: { status: withdrawal.status }, newValue: { status: "PROCESSING", attemptCount: attemptNumber }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
      return { id: withdrawal.id, status: "PROCESSING" as const, replayed: false, attemptCount: attemptNumber };
    }

    if (withdrawal.status !== "PROCESSING") throw new ApiError("Withdrawal harus PROCESSING sebelum diselesaikan.", "INVALID_WITHDRAWAL_TRANSITION", 409);
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${withdrawal.walletId} FOR UPDATE`);
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, withdrawal.walletId)).limit(1);
    if (!wallet || wallet.pendingBalance < withdrawal.amount) throw new ApiError("Saldo pending tidak sesuai dengan withdrawal.", "WALLET_INTEGRITY_ERROR", 500);

    const isSuccess = input.decision === "SUCCESS";
    const isRetryable = input.decision === "FAILED_RETRYABLE";
    const terminalFailure = input.decision === "FAILED_FINAL";
    if ((isSuccess || isRetryable || terminalFailure) && input.source !== "PROVIDER") {
      throw new ApiError("SUCCESS/FAILED hanya dapat ditetapkan berdasarkan konfirmasi payout provider.", "WITHDRAWAL_PROVIDER_CONFIRMATION_REQUIRED", 409);
    }
    if (!isSuccess && !isRetryable && !terminalFailure) throw new ApiError("State withdrawal tidak valid.", "INVALID_WITHDRAWAL_TRANSITION", 400);

    const outcome = resolveWithdrawalFailure({ decision: input.decision, attemptCount: withdrawal.attemptCount, maxAttempts: MAX_WITHDRAWAL_ATTEMPTS });
    const finalStatus = outcome.status;
    const nextRetryAt = finalStatus === "FAILED_RETRYABLE" ? retryAt(withdrawal.attemptCount) : null;
    // PROCESSING reserves funds in pendingBalance. A terminal outcome (SUCCESS or
    // FAILED_FINAL) must consume/release that reservation exactly once.
    const terminalOutcome = isSuccess || finalStatus === "FAILED_FINAL";
    const shouldRefundFunds = terminalFailure || finalStatus === "FAILED_FINAL";
    const pendingRelease = terminalOutcome ? withdrawal.amount : 0;
    const pendingAfter = wallet.pendingBalance - pendingRelease;
    const availableAfter = shouldRefundFunds ? wallet.availableBalance + withdrawal.amount : wallet.availableBalance;
    if (pendingAfter < 0) {
      throw new ApiError("Saldo pending tidak cukup untuk menyelesaikan withdrawal.", "WALLET_PENDING_BALANCE_MISMATCH", 500);
    }

    // pendingBalance is a reservation bucket: it increases exactly once when the
    // withdrawal is created, stays unchanged while retryable, and is released
    // exactly once on SUCCESS or FAILED_FINAL. No other balance bucket may move
    // on SUCCESS; FAILED_FINAL returns the released amount to availableBalance.
    const totalBefore = wallet.availableBalance + wallet.lockedBalance + wallet.pendingBalance;
    const totalAfter = availableAfter + wallet.lockedBalance + pendingAfter;
    const expectedTotalAfter = totalBefore - (isSuccess ? withdrawal.amount : 0);
    if (totalAfter !== expectedTotalAfter) {
      throw new ApiError("Accounting wallet tidak konsisten saat menyelesaikan withdrawal.", "WALLET_ACCOUNTING_MISMATCH", 500);
    }

    await tx.update(wallets).set({ availableBalance: availableAfter, pendingBalance: pendingAfter, updatedAt: now }).where(eq(wallets.id, wallet.id));

    const errorCode = outcome.errorCode;
    const errorMessage = outcome.errorMessage;
    await tx.update(withdrawals).set({ status: finalStatus, processedAt: finalStatus === "SUCCESS" || finalStatus === "FAILED_FINAL" ? now : null, nextRetryAt: finalStatus === "FAILED_RETRYABLE" ? nextRetryAt : null, lastErrorCode: errorCode, lastErrorMessage: errorMessage, ...(providerReference ? { providerReference } : {}), updatedAt: now }).where(eq(withdrawals.id, withdrawal.id));
    await tx.insert(withdrawalAttempts).values({
      withdrawalId: withdrawal.id, attemptNumber: withdrawal.attemptCount, fromStatus: "PROCESSING", toStatus: finalStatus,
      idempotencyKey: `WITHDRAWAL-ATTEMPT-${withdrawal.id}-${withdrawal.attemptCount}-${finalStatus}`,
      errorCode, errorMessage, providerReference: providerReference ?? withdrawal.providerReference, nextRetryAt: finalStatus === "FAILED_RETRYABLE" ? nextRetryAt : null,
    });
    if (isSuccess || terminalFailure || finalStatus === "FAILED_FINAL") {
      await tx.insert(walletTransactions).values({
        walletId: wallet.id, userId: withdrawal.userId, type: isSuccess ? "WITHDRAW" : "REFUND", direction: isSuccess ? "DEBIT" : "CREDIT", amount: withdrawal.amount,
        availableBefore: wallet.availableBalance, availableAfter, lockedBefore: wallet.lockedBalance, lockedAfter: wallet.lockedBalance, pendingBefore: wallet.pendingBalance, pendingAfter,
        referenceType: "withdrawal", referenceId: withdrawal.id, description: isSuccess ? "Withdrawal berhasil dikirim" : "Pengembalian dana withdrawal gagal",
        idempotencyKey: `WITHDRAWAL-${withdrawal.id}-${finalStatus}`,
      });
    }
    await tx.insert(notifications).values({ userId: withdrawal.userId, title: isSuccess ? "Withdrawal berhasil" : finalStatus === "FAILED_RETRYABLE" ? "Withdrawal sedang dicoba kembali" : "Withdrawal gagal", message: isSuccess ? `Withdrawal ${withdrawal.amount.toLocaleString("id-ID")} telah diproses.` : finalStatus === "FAILED_RETRYABLE" ? `Withdrawal gagal sementara. Sistem dapat mencoba kembali setelah ${nextRetryAt?.toLocaleString("id-ID") ?? "waktu retry"}.` : `Dana ${withdrawal.amount.toLocaleString("id-ID")} telah dikembalikan ke saldo tersedia.`, type: isSuccess ? "WITHDRAWAL_SUCCESS" : finalStatus === "FAILED_RETRYABLE" ? "WITHDRAWAL_RETRYABLE" : "WITHDRAWAL_FAILED", referenceType: "withdrawal", referenceId: withdrawal.id }).onConflictDoNothing();
    await tx.insert(auditLogs).values({ actorId: input.adminId ?? null, actorType: input.adminRole, action: isSuccess ? "WITHDRAWAL_SUCCEEDED" : finalStatus === "FAILED_RETRYABLE" ? "WITHDRAWAL_FAILED_RETRYABLE" : "WITHDRAWAL_FAILED_FINAL", entityType: "withdrawal", entityId: withdrawal.id, oldValue: { status: withdrawal.status }, newValue: { status: finalStatus, attemptCount: withdrawal.attemptCount, nextRetryAt }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
    return { id: withdrawal.id, status: finalStatus, replayed: false, attemptCount: withdrawal.attemptCount, nextRetryAt };
  });
}

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
    const now = new Date();
    const attemptNumber = payout.attemptCount + 1;
    await tx.update(payouts).set({ status: "PROCESSING", attemptCount: attemptNumber, nextRetryAt: null, updatedAt: now }).where(eq(payouts.id, payout.id));
    await tx.insert(payoutAttempts).values({ payoutId: payout.id, attemptNumber, fromStatus: "FAILED_RETRYABLE", toStatus: "PROCESSING", idempotencyKey: `PAYOUT-ATTEMPT-${payout.id}-${attemptNumber}-PROCESSING` });
    return { payoutId: payout.id, status: "PROCESSING" as const, attemptNumber };
  });
}


export async function executeWithdrawal(input: { withdrawalId: string; adminId: string; adminRole: "ADMIN" | "SUPER_ADMIN"; meta?: { ipAddress?: string | null; userAgent?: string | null } }) {
  const provider = getPayoutProvider();
  const started = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`);
    const [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, input.withdrawalId)).limit(1);
    if (!withdrawal) throw new ApiError("Withdrawal tidak ditemukan.", "WITHDRAWAL_NOT_FOUND", 404);
    if (withdrawal.status === "SUCCESS") return { withdrawal, replayed: true, needsCreate: false };
    if (withdrawal.approvalStatus !== "APPROVED") throw new ApiError("Withdrawal harus di-approve sebelum payout provider dipanggil.", "WITHDRAWAL_APPROVAL_REQUIRED", 409);
    if (withdrawal.approvedBy === input.adminId) throw new ApiError("Maker dan checker harus merupakan administrator yang berbeda.", "MAKER_CHECKER_SEPARATION_REQUIRED", 403);
    if (withdrawal.riskStatus !== "CLEAR") throw new ApiError("Withdrawal masih berada dalam review risiko.", "WITHDRAWAL_RISK_REVIEW_REQUIRED", 409);
    if (withdrawal.status === "FAILED_FINAL" || withdrawal.status === "CANCELLED") throw new ApiError("Withdrawal sudah berada pada terminal state.", "WITHDRAWAL_TERMINAL", 409);
    const now = new Date();
    if (withdrawal.status === "FAILED_RETRYABLE" && !isWithdrawalRetryDue(withdrawal.nextRetryAt, now)) throw new ApiError("Retry withdrawal belum jatuh tempo.", "WITHDRAWAL_RETRY_NOT_DUE", 409);
    if (withdrawal.status === "PENDING" || withdrawal.status === "FAILED_RETRYABLE") {
      if (withdrawal.attemptCount >= MAX_WITHDRAWAL_ATTEMPTS) throw new ApiError("Batas percobaan withdrawal telah tercapai.", "WITHDRAWAL_MAX_ATTEMPTS", 409);
      const attemptNumber=withdrawal.attemptCount+1;
      await tx.update(withdrawals).set({status:"PROCESSING",attemptCount:attemptNumber,nextRetryAt:null,updatedAt:now}).where(eq(withdrawals.id,withdrawal.id));
      await tx.insert(withdrawalAttempts).values({withdrawalId:withdrawal.id,attemptNumber,fromStatus:withdrawal.status,toStatus:"PROCESSING",idempotencyKey:`WITHDRAWAL-ATTEMPT-${withdrawal.id}-${attemptNumber}-PROCESSING`});
      return { withdrawal: {...withdrawal,status:"PROCESSING" as const,attemptCount:attemptNumber}, replayed:false, needsCreate:true };
    }
    return { withdrawal, replayed:false, needsCreate:false };
  });
  if (started.replayed) return { id: started.withdrawal.id, status: "SUCCESS" as const, withdrawal: financialWithdrawalView(started.withdrawal), replayed: true, providerStatus: "SUCCESS" as const };
  const w=started.withdrawal;
  const reference=stablePayoutReference(w.id);
  const handleProviderResult = async (result: Awaited<ReturnType<typeof provider.createDisbursement>>) => {
    if (result.status === "PROCESSING") {
      await persistWithdrawalProviderReference({ withdrawalId: w.id, attemptCount: w.attemptCount, providerReference: result.providerReference });
      return { id: w.id, status: "PROCESSING" as const, replayed: false, providerStatus: result.status };
    }
    return processWithdrawal({ withdrawalId: w.id, decision: result.status, adminId: input.adminId, adminRole: input.adminRole, meta: input.meta, source: "PROVIDER", providerReference: result.providerReference });
  };
  const handleProviderStatus = async (status: Awaited<ReturnType<typeof provider.getDisbursementStatus>>) => {
    if (status.status === "PROCESSING") {
      await persistWithdrawalProviderReference({ withdrawalId: w.id, attemptCount: w.attemptCount, providerReference: status.providerReference });
      return { id: w.id, status: "PROCESSING" as const, replayed: false, providerStatus: status.status };
    }
    return processWithdrawal({ withdrawalId: w.id, decision: status.status, adminId: input.adminId, adminRole: input.adminRole, meta: input.meta, source: "PROVIDER", providerReference: status.providerReference });
  };
  if (!started.needsCreate) {
    const status = await provider.getDisbursementStatus(reference);
    if (status.status === "SUCCESS" || status.status === "FAILED_FINAL") return handleProviderStatus(status);
    if (status.status === "FAILED_RETRYABLE") {
      // The provider may return 404/retryable while another executor has not yet
      // completed the idempotent create call. Re-submit with the same reference;
      // the provider idempotency key prevents a duplicate disbursement.
      try {
        const result = await provider.createDisbursement({reference,bankName:decryptBankPii(w.bankName),accountName:decryptBankPii(w.accountName),accountNumber:decryptBankPii(w.accountNumber),amount:w.amount});
        return handleProviderResult(result);
      } catch {
        return { id:w.id, status:"PROCESSING" as const, replayed:false, providerStatus:"PROCESSING" as const };
      }
    }
    return handleProviderStatus(status);
  }
  try {
    const result=await provider.createDisbursement({reference,bankName:decryptBankPii(w.bankName),accountName:decryptBankPii(w.accountName),accountNumber:decryptBankPii(w.accountNumber),amount:w.amount});
    return handleProviderResult(result);
  } catch (error) {
    // A timeout is ambiguous: ask the provider before releasing or retrying funds.
    try {
      const status=await provider.getDisbursementStatus(reference);
      if(status.status !== "PROCESSING") return handleProviderStatus(status);
      await persistWithdrawalProviderReference({ withdrawalId: w.id, attemptCount: w.attemptCount, providerReference: status.providerReference });
    } catch { /* retain PROCESSING so an explicit reconciliation can resolve it */ }
    throw error instanceof ApiError ? error : new ApiError("Status payout tidak dapat dipastikan; withdrawal tetap PROCESSING untuk rekonsiliasi.","PAYOUT_AMBIGUOUS",502);
  }
}
