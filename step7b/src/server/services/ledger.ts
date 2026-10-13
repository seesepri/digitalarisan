import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, financialAccounts, financialTransactions, walletTransactions, wallets, users } from "@/db/schema";
import { ApiError } from "@/server/http";

/**
 * Append-only correction for a wallet ledger entry.
 * This does not edit the historical row; it appends an ADJUSTMENT entry
 * using the inverse balance delta of the original transaction.
 */
export async function reverseWalletTransaction(input: {
  transactionId: string;
  actorId: string;
  idempotencyKey: string;
  reason: string;
}) {
  return db.transaction(async (tx) => {
    const [operator] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, input.actorId)).limit(1);
    if (!operator || operator.role !== "SUPER_ADMIN" || operator.status !== "ACTIVE") throw new ApiError("Koreksi ledger memerlukan super administrator aktif.", "FORBIDDEN", 403);
    const [original] = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.id, input.transactionId))
      .limit(1);
    if (!original) throw new ApiError("Transaksi wallet tidak ditemukan.", "LEDGER_ENTRY_NOT_FOUND", 404);
    if (original.status !== "SUCCESS") throw new ApiError("Hanya transaksi SUCCESS yang dapat direversal.", "LEDGER_ENTRY_NOT_REVERSIBLE", 409);

    const [byKey] = await tx.select().from(walletTransactions).where(eq(walletTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
    if (byKey && byKey.reversalOfId !== original.id) throw new ApiError("Idempotency key koreksi telah digunakan untuk transaksi lain.", "IDEMPOTENCY_CONFLICT", 409);
    const [existing] = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.reversalOfId, original.id))
      .limit(1);
    if (existing) return { transaction: existing, replayed: true };

    // Serialize all reversals for the same wallet before making the final
    // reversal-of check. The first pre-lock check is only a fast path; a
    // concurrent request may have created the compensating entry while this
    // transaction was waiting for the wallet lock.
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${original.walletId} FOR UPDATE`);
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, original.walletId)).limit(1);
    if (!wallet) throw new ApiError("Wallet tidak ditemukan.", "WALLET_NOT_FOUND", 404);

    const [existingAfterLock] = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.reversalOfId, original.id))
      .limit(1);
    if (existingAfterLock) return { transaction: existingAfterLock, replayed: true };

    if (original.lockedAfter !== original.lockedBefore || original.pendingAfter !== original.pendingBefore) throw new ApiError("Transaksi reservation/withdrawal harus dipulihkan melalui state machine domain dengan bukti provider, bukan reversal generik.", "LEDGER_DOMAIN_RECOVERY_REQUIRED", 409);
    const availableDelta = original.availableAfter - original.availableBefore;
    const lockedDelta = original.lockedAfter - original.lockedBefore;
    const pendingDelta = original.pendingAfter - original.pendingBefore;
    const availableAfter = wallet.availableBalance - availableDelta;
    const lockedAfter = wallet.lockedBalance - lockedDelta;
    const pendingAfter = wallet.pendingBalance - pendingDelta;
    if (availableAfter < 0 || lockedAfter < 0 || pendingAfter < 0) {
      throw new ApiError("Reversal akan menghasilkan saldo negatif.", "LEDGER_REVERSAL_NEGATIVE_BALANCE", 409);
    }

    const direction = original.direction === "CREDIT" ? "DEBIT" : "CREDIT";
    const [created] = await tx.insert(walletTransactions).values({
      walletId: original.walletId,
      userId: original.userId,
      type: "ADJUSTMENT",
      direction,
      amount: original.amount,
      availableBefore: wallet.availableBalance,
      availableAfter,
      lockedBefore: wallet.lockedBalance,
      lockedAfter,
      pendingBefore: wallet.pendingBalance,
      pendingAfter,
      referenceType: "wallet_transaction_reversal",
      referenceId: original.id,
      description: `Reversal: ${input.reason}`,
      status: "SUCCESS",
      idempotencyKey: input.idempotencyKey,
      reversalOfId: original.id,
    }).returning();

    await tx.update(wallets).set({
      availableBalance: availableAfter,
      lockedBalance: lockedAfter,
      pendingBalance: pendingAfter,
      updatedAt: new Date(),
    }).where(eq(wallets.id, wallet.id));
    await tx.insert(auditLogs).values({ actorId: input.actorId, actorType: "SUPER_ADMIN", action: "WALLET_LEDGER_REVERSED", entityType: "wallet_transaction", entityId: created.id, newValue: { reversalOfId: original.id, reason: input.reason, idempotencyKey: input.idempotencyKey } });
    return { transaction: created, replayed: false };
  });
}

/**
 * Append-only correction for a system financial account entry.
 * The historical financial transaction is never updated or deleted.
 */
export async function reverseFinancialTransaction(input: {
  transactionId: string;
  actorId: string;
  idempotencyKey: string;
  reason: string;
}) {
  return db.transaction(async (tx) => {
    const [operator] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, input.actorId)).limit(1);
    if (!operator || operator.role !== "SUPER_ADMIN" || operator.status !== "ACTIVE") throw new ApiError("Koreksi ledger memerlukan super administrator aktif.", "FORBIDDEN", 403);
    const [original] = await tx
      .select()
      .from(financialTransactions)
      .where(eq(financialTransactions.id, input.transactionId))
      .limit(1);
    if (!original) throw new ApiError("Transaksi financial tidak ditemukan.", "FINANCIAL_LEDGER_ENTRY_NOT_FOUND", 404);

    const [byKey] = await tx.select().from(financialTransactions).where(eq(financialTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
    if (byKey && byKey.reversalOfId !== original.id) throw new ApiError("Idempotency key koreksi telah digunakan untuk transaksi lain.", "IDEMPOTENCY_CONFLICT", 409);
    const [existing] = await tx
      .select()
      .from(financialTransactions)
      .where(eq(financialTransactions.reversalOfId, original.id))
      .limit(1);
    if (existing) return { transaction: existing, replayed: true };

    // Serialize reversals for the same financial account before the final
    // reversal-of check. Without this second check, two concurrent requests
    // with different idempotency keys could both reverse the same entry.
    const [account] = await tx.select().from(financialAccounts).where(eq(financialAccounts.id, original.accountId)).for("update").limit(1);
    if (!account) throw new ApiError("Financial account tidak ditemukan.", "FINANCIAL_ACCOUNT_NOT_FOUND", 404);

    const [existingAfterLock] = await tx
      .select()
      .from(financialTransactions)
      .where(eq(financialTransactions.reversalOfId, original.id))
      .limit(1);
    if (existingAfterLock) return { transaction: existingAfterLock, replayed: true };

    const delta = original.direction === "CREDIT" ? original.amount : -original.amount;
    const balanceAfter = Number(account.balance) - delta;
    if (balanceAfter < 0) throw new ApiError("Reversal akan menghasilkan saldo account negatif.", "FINANCIAL_REVERSAL_NEGATIVE_BALANCE", 409);

    const direction = original.direction === "CREDIT" ? "DEBIT" : "CREDIT";
    const [created] = await tx.insert(financialTransactions).values({
      accountId: original.accountId,
      direction,
      amount: original.amount,
      balanceBefore: Number(account.balance),
      balanceAfter,
      referenceType: "financial_transaction_reversal",
      referenceId: original.id,
      description: `Reversal: ${input.reason}`,
      idempotencyKey: input.idempotencyKey,
      reversalOfId: original.id,
    }).returning();

    await tx.update(financialAccounts).set({ balance: balanceAfter, updatedAt: new Date() }).where(eq(financialAccounts.id, original.accountId));
    await tx.insert(auditLogs).values({ actorId: input.actorId, actorType: "SUPER_ADMIN", action: "FINANCIAL_LEDGER_REVERSED", entityType: "financial_transaction", entityId: created.id, newValue: { reversalOfId: original.id, reason: input.reason, idempotencyKey: input.idempotencyKey } });
    return { transaction: created, replayed: false };
  });
}
