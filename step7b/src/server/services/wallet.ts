import { decryptBankPii, encryptBankPii, safeWithdrawalView } from "@/server/services/pii";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { cursorWhere, decodeCursor, encodeCursor, parsePageSize } from "@/server/pagination";
import { auditLogs, notifications, topups, users, walletTransactions, wallets, withdrawals } from "@/db/schema";
import { ApiError, positiveInteger } from "@/server/http";
import { getPaymentProvider } from "@/server/services/payment-provider";
import { assessWithdrawalRisk } from "@/server/services/compliance";

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

export async function createTopup(input: {
  userId: string;
  amount: number;
  idempotencyKey: string;
  callbackUrl: string;
  meta?: RequestMeta;
}) {
  positiveInteger(input.amount, "Nominal top-up", 50_000_000);
  const provider = getPaymentProvider();
  const createdResult = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM wallets WHERE user_id = ${input.userId} FOR UPDATE`);
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, input.userId)).limit(1);
    if (!wallet) throw new ApiError("Wallet pengguna tidak ditemukan.", "WALLET_NOT_FOUND", 404);

    const [previous] = await tx.select().from(topups).where(eq(topups.idempotencyKey, input.idempotencyKey)).limit(1);
    if (previous) {
      if (previous.userId !== input.userId || previous.amount !== input.amount || previous.provider !== provider.name) {
        throw new ApiError("Idempotency key telah digunakan untuk intent top-up lain.", "IDEMPOTENCY_CONFLICT", 409);
      }
      return { topup: previous, replayed: true };
    }

    const now = new Date();
    const [created] = await tx.insert(topups).values({
      walletId: wallet.id,
      userId: input.userId,
      amount: input.amount,
      provider: provider.name,
      providerReference: null,
      checkoutUrl: null,
      idempotencyKey: input.idempotencyKey,
      status: "PENDING",
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    }).returning();
    await tx.insert(auditLogs).values({
      actorId: input.userId, actorType: "USER", action: "TOPUP_INTENT_CREATED", entityType: "topup", entityId: created.id,
      newValue: { amount: created.amount, provider: created.provider, status: created.status },
      ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null,
    });
    return { topup: created, replayed: false };
  });

  if (createdResult.replayed) {
    if (createdResult.topup.checkoutUrl || createdResult.topup.status === "SUCCESS") return { topup: createdResult.topup, replayed: true };
    // Lost/ambiguous create response: inquire, never blindly create another charge.
    if (!provider.getPaymentStatus) throw new ApiError("Intent top-up perlu rekonsiliasi provider, bukan create ulang.", "TOPUP_RECONCILIATION_REQUIRED", 409);
    return reconcileTopupPayment({ topupId: createdResult.topup.id, meta: input.meta });
  }

  try {
    await db.update(topups).set({ paymentCreateAttempts: sql`${topups.paymentCreateAttempts} + 1`, lastPaymentAttemptAt: new Date(), lastPaymentErrorCode: null, lastPaymentErrorMessage: null, updatedAt: new Date() }).where(eq(topups.id, createdResult.topup.id));
    const payment = await provider.createPayment({
      reference: createdResult.topup.id,
      amount: createdResult.topup.amount,
      currency: "IDR",
      expiresAt: createdResult.topup.expiresAt,
      callbackUrl: input.callbackUrl,
    });
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM topups WHERE id = ${createdResult.topup.id} FOR UPDATE`);
      const [current] = await tx.select().from(topups).where(eq(topups.id, createdResult.topup.id)).limit(1);
      if (!current) throw new ApiError("Top-up tidak ditemukan setelah pembuatan payment.", "TOPUP_NOT_FOUND", 500);
      if (current.status !== "PENDING") return current;
      const [result] = await tx.update(topups).set({
        providerReference: payment.providerReference,
        checkoutUrl: payment.checkoutUrl,
        expiresAt: payment.expiresAt,
        status: "PROCESSING",
        updatedAt: new Date(),
      }).where(eq(topups.id, current.id)).returning();
      return result;
    });
    return { topup: updated, replayed: false };
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "PAYMENT_PROVIDER_CREATE_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Payment provider error";
    await db.update(topups).set({ status: "PENDING", lastPaymentErrorCode: code, lastPaymentErrorMessage: message, updatedAt: new Date() }).where(and(eq(topups.id, createdResult.topup.id), eq(topups.status, "PENDING")));
    throw error;
  }
}

function sameWithdrawalIntent(previous: typeof withdrawals.$inferSelect, input: { userId: string; amount: number; bankName: string; accountName: string; accountNumber: string }) {
  return previous.userId === input.userId && previous.amount === input.amount
    && decryptBankPii(previous.bankName).trim() === input.bankName.trim()
    && decryptBankPii(previous.accountName).trim() === input.accountName.trim()
    && decryptBankPii(previous.accountNumber).trim() === input.accountNumber.trim();
}

export async function createWithdrawal(input: {
  userId: string;
  amount: number;
  bankName: string;
  accountName: string;
  accountNumber: string;
  idempotencyKey: string;
  meta?: RequestMeta;
}) {
  positiveInteger(input.amount, "Nominal withdrawal", 50_000_000);
  if ([input.bankName, input.accountName, input.accountNumber].some((value) => /^enc:/i.test(value.trim()) || /[\u0000-\u001f\u007f]/.test(value))) throw new ApiError("Data rekening harus berupa teks biasa yang valid, bukan ciphertext/control characters.", "VALIDATION_ERROR", 400);
  if (!/^\d{6,32}$/.test(input.accountNumber.trim()) || !input.bankName.trim() || !input.accountName.trim()) throw new ApiError("Rekening withdrawal tidak valid.", "VALIDATION_ERROR", 400);
  return db.transaction(async (tx) => {
    const [previous] = await tx.select().from(withdrawals).where(eq(withdrawals.idempotencyKey, input.idempotencyKey)).limit(1);
    if (previous) {
      if (!sameWithdrawalIntent(previous, input)) {
        throw new ApiError("Idempotency key telah digunakan untuk withdrawal lain.", "IDEMPOTENCY_CONFLICT", 409);
      }
      return { withdrawal: safeWithdrawalView(previous), replayed: true };
    }
    const [user] = await tx.select({ kycStatus: users.kycStatus, status: users.status }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user) throw new ApiError("Pengguna tidak ditemukan.", "USER_NOT_FOUND", 404);
    if (user.status !== "ACTIVE") throw new ApiError("Akun pengguna tidak aktif.", "USER_INACTIVE", 403);
    if (user.kycStatus !== "VERIFIED") throw new ApiError("KYC belum terverifikasi. Withdrawal belum dapat dilakukan.", "KYC_REQUIRED", 403);

    await tx.execute(sql`SELECT id FROM wallets WHERE user_id = ${input.userId} FOR UPDATE`);
    const [afterLock] = await tx.select().from(withdrawals).where(eq(withdrawals.idempotencyKey, input.idempotencyKey)).limit(1);
    if (afterLock) {
      if (!sameWithdrawalIntent(afterLock, input)) {
        throw new ApiError("Idempotency key telah digunakan untuk withdrawal lain.", "IDEMPOTENCY_CONFLICT", 409);
      }
      return { withdrawal: safeWithdrawalView(afterLock), replayed: true };
    }
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, input.userId)).limit(1);
    if (!wallet) throw new ApiError("Wallet pengguna tidak ditemukan.", "WALLET_NOT_FOUND", 404);
    if (wallet.availableBalance < input.amount) {
      throw new ApiError("Saldo tersedia tidak mencukupi untuk withdrawal.", "INSUFFICIENT_BALANCE", 409);
    }

    const [withdrawal] = await tx
      .insert(withdrawals)
      .values({
        walletId: wallet.id,
        userId: input.userId,
        amount: input.amount,
        bankName: encryptBankPii(input.bankName.trim()),
        accountName: encryptBankPii(input.accountName.trim()),
        accountNumber: encryptBankPii(input.accountNumber.trim()),
        idempotencyKey: input.idempotencyKey,
        status: "PENDING",
      })
      .returning();
    const risk = await assessWithdrawalRisk(tx, { userId: input.userId, amount: input.amount, withdrawalId: withdrawal.id });
    const [riskUpdated] = await tx.update(withdrawals).set({ riskStatus: risk.riskStatus, riskScore: risk.riskScore, updatedAt: new Date() }).where(eq(withdrawals.id, withdrawal.id)).returning();
    const now = new Date();
    const availableAfter = wallet.availableBalance - input.amount;
    const pendingAfter = wallet.pendingBalance + input.amount;
    await tx
      .update(wallets)
      .set({ availableBalance: availableAfter, pendingBalance: pendingAfter, updatedAt: now })
      .where(eq(wallets.id, wallet.id));
    await tx.insert(walletTransactions).values({
      walletId: wallet.id,
      userId: input.userId,
      type: "WITHDRAW",
      direction: "DEBIT",
      amount: input.amount,
      availableBefore: wallet.availableBalance,
      availableAfter,
      lockedBefore: wallet.lockedBalance,
      lockedAfter: wallet.lockedBalance,
      pendingBefore: wallet.pendingBalance,
      pendingAfter,
      referenceType: "withdrawal",
      referenceId: withdrawal.id,
      description: "Saldo tersedia ditahan untuk withdrawal",
      idempotencyKey: input.idempotencyKey,
    });
    await tx.insert(notifications).values({
      userId: input.userId,
      title: "Withdrawal diajukan",
      message: `${formatRupiah(input.amount)} ditahan dari saldo tersedia dan sedang menunggu proses.`,
      type: "WITHDRAWAL_PENDING",
      referenceType: "withdrawal",
      referenceId: withdrawal.id,
    });
    await tx.insert(auditLogs).values({
      actorId: input.userId,
      actorType: "USER",
      action: "WITHDRAWAL_REQUESTED",
      entityType: "withdrawal",
      entityId: withdrawal.id,
      newValue: { amount: input.amount, status: "PENDING", riskStatus: risk.riskStatus, riskScore: risk.riskScore },
      ipAddress: input.meta?.ipAddress ?? null,
      userAgent: input.meta?.userAgent ?? null,
    });
    return { withdrawal: safeWithdrawalView(riskUpdated), replayed: false };
  });
}

export async function listWalletTransactions(userId: string, limit = 50, rawCursor: string | null = null) {
  const pageSize = parsePageSize(String(limit), 50, 100);
  const cursor = decodeCursor(rawCursor);
  const rows = await db
    .select({
      id: walletTransactions.id,
      type: walletTransactions.type,
      direction: walletTransactions.direction,
      amount: walletTransactions.amount,
      availableBefore: walletTransactions.availableBefore,
      availableAfter: walletTransactions.availableAfter,
      lockedBefore: walletTransactions.lockedBefore,
      lockedAfter: walletTransactions.lockedAfter,
      pendingBefore: walletTransactions.pendingBefore,
      pendingAfter: walletTransactions.pendingAfter,
      referenceType: walletTransactions.referenceType,
      referenceId: walletTransactions.referenceId,
      description: walletTransactions.description,
      status: walletTransactions.status,
      createdAt: walletTransactions.createdAt,
    })
    .from(walletTransactions)
    .where(and(eq(walletTransactions.userId, userId), cursorWhere(cursor, walletTransactions.createdAt, walletTransactions.id)))
    .orderBy(sql`${walletTransactions.createdAt} DESC`, sql`${walletTransactions.id} DESC`)
    .limit(pageSize + 1);
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  return { transactions: page, nextCursor: rows.length > pageSize && last ? encodeCursor(last.createdAt, last.id) : null };
}

function formatRupiah(amount: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(amount);
}


export async function reconcileTopupPayment(input: { topupId: string; meta?: RequestMeta }) {
  const provider = getPaymentProvider();
  if (!provider.getPaymentStatus) throw new ApiError("Provider belum mendukung rekonsiliasi status pembayaran.", "PAYMENT_RECONCILIATION_UNAVAILABLE", 503);
  const [topup] = await db.select().from(topups).where(eq(topups.id, input.topupId)).limit(1);
  if (!topup) throw new ApiError("Top-up tidak ditemukan.", "TOPUP_NOT_FOUND", 404);
  if (topup.status === "SUCCESS") return { topup, replayed: true };
  if (topup.provider !== provider.name) throw new ApiError("Provider aktif tidak cocok dengan intent top-up.", "PAYMENT_PROVIDER_MISMATCH", 409);
  const reference = topup.id;
  const status = await provider.getPaymentStatus(reference);
  if (status.provider !== topup.provider || status.reference !== topup.id || status.currency !== "IDR" || (status.status !== "PROCESSING" && status.amount !== topup.amount) || (status.amount !== 0 && status.amount !== topup.amount)) throw new ApiError("Nominal provider tidak cocok dengan top-up.", "PAYMENT_MISMATCH", 409);
  if (status.status === "PROCESSING") return { topup, replayed: false, providerStatus: status.status };
  const eventId = `RECONCILE-${topup.id}-${status.status}`;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM topups WHERE id = ${topup.id} FOR UPDATE`);
    const [current] = await tx.select().from(topups).where(eq(topups.id, topup.id)).limit(1);
    if (!current) throw new ApiError("Top-up tidak ditemukan.", "TOPUP_NOT_FOUND", 404);
    if (current.status === "SUCCESS") return current;
    if (status.status === "EXPIRED" || status.status === "FAILED") {
      const finalStatus = status.status;
      if (current.status === "FAILED" || current.status === "EXPIRED") return current;
      await tx.update(topups).set({ status: finalStatus, updatedAt: new Date() }).where(eq(topups.id, current.id));
      await tx.insert(auditLogs).values({ actorType: "SYSTEM", action: finalStatus === "EXPIRED" ? "TOPUP_RECONCILED_EXPIRED" : "TOPUP_RECONCILED_FAILED", entityType: "topup", entityId: current.id, newValue: { eventId, providerStatus: status.status }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
      return { ...current, status: finalStatus };
    }
    await tx.execute(sql`SELECT id FROM wallets WHERE id = ${current.walletId} FOR UPDATE`);
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, current.walletId)).limit(1);
    if (!wallet) throw new ApiError("Wallet top-up tidak ditemukan.", "WALLET_NOT_FOUND", 404);
    const ledgerKey = `TOPUP-${current.id}`;
    const [existing] = await tx.select({ id: walletTransactions.id }).from(walletTransactions).where(eq(walletTransactions.idempotencyKey, ledgerKey)).limit(1);
    if (!existing) {
      const now = new Date(); const availableAfter = wallet.availableBalance + current.amount;
      await tx.update(wallets).set({ availableBalance: availableAfter, updatedAt: now }).where(eq(wallets.id, wallet.id));
      await tx.insert(walletTransactions).values({ walletId: wallet.id, userId: current.userId, type: "TOPUP", direction: "CREDIT", amount: current.amount, availableBefore: wallet.availableBalance, availableAfter, lockedBefore: wallet.lockedBalance, lockedAfter: wallet.lockedBalance, pendingBefore: wallet.pendingBalance, pendingAfter: wallet.pendingBalance, referenceType: "topup", referenceId: current.id, description: "Top-up dipulihkan melalui rekonsiliasi provider", idempotencyKey: ledgerKey });
    }
    await tx.update(topups).set({ status: "SUCCESS", providerReference: current.providerReference ?? status.providerReference ?? null, paidAt: current.paidAt ?? new Date(), updatedAt: new Date() }).where(eq(topups.id, current.id));
    await tx.insert(auditLogs).values({ actorType: "SYSTEM", action: "TOPUP_RECONCILED_PAID", entityType: "topup", entityId: current.id, newValue: { eventId, providerStatus: status.status, amount: current.amount }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
    return { ...current, status: "SUCCESS" as const, providerReference: current.providerReference ?? status.providerReference ?? null, paidAt: current.paidAt ?? new Date() };
  });
  return { topup: result, replayed: false, providerStatus: status.status };
}
