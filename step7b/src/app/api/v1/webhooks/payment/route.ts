import { createHash } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, notifications, paymentWebhookEvents, topups, walletTransactions, wallets } from "@/db/schema";
import { enforceRateLimit, errorResponse, jsonOk, getRequestMetadata, readLimitedText, ApiError } from "@/server/http";
import { getPaymentProvider } from "@/server/services/payment-provider";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "payment-webhook", 120, 60_000);
    const rawBody = await readLimitedText(request, 32_000);
    if (rawBody.length > 32_000) throw new ApiError("Payload webhook terlalu besar.", "PAYLOAD_TOO_LARGE", 413);
    const provider = getPaymentProvider();
    const event = provider.verifyWebhook({
      rawBody,
      signature: request.headers.get("x-payment-signature") ?? undefined,
      timestamp: request.headers.get("x-payment-timestamp") ?? undefined,
    });
    const metadata = getRequestMetadata(request);
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");

    const result = await db.transaction(async (tx) => {
      const isUuidReference = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.reference);
      const candidates = await tx.select().from(topups).where(and(eq(topups.provider, event.provider), or(
        eq(topups.providerReference, event.reference), isUuidReference ? eq(topups.id, event.reference) : sql`false`,
      ))).for("update").limit(2);
      if (candidates.length > 1) throw new ApiError("Reference webhook ambigu.", "PAYMENT_REFERENCE_AMBIGUOUS", 409);
      const [topup] = candidates;
      if (!topup) throw new ApiError("Top-up tidak ditemukan.", "TOPUP_NOT_FOUND", 404);
      if (topup.provider !== event.provider || topup.amount !== event.amount || event.currency !== "IDR") {
        throw new ApiError("Nominal, currency, atau provider tidak cocok dengan intent top-up.", "PAYMENT_MISMATCH", 409);
      }

      const [insertedEvent] = await tx.insert(paymentWebhookEvents).values({
        provider: event.provider,
        providerEventId: event.eventId,
        topupId: topup.id,
        signatureTimestamp: event.provider === "midtrans" ? null : (request.headers.get("x-payment-timestamp") ?? null),
        payloadHash,
      }).onConflictDoNothing().returning({ id: paymentWebhookEvents.id });
      if (!insertedEvent) return { duplicate: true, status: topup.status };
      // Provider status is authoritative and must be monotonic locally: a later PAID/SUCCESS
      // event may recover a locally EXPIRED/FAILED intent, while stale PROCESSING/terminal
      // events must never downgrade a confirmed SUCCESS.
      if (topup.status === "SUCCESS") return { duplicate: true, status: "SUCCESS" };
      if (event.status === "PROCESSING" && ["FAILED", "EXPIRED"].includes(topup.status)) return { duplicate: true, status: topup.status };
      if (["FAILED", "EXPIRED"].includes(event.status) && ["FAILED", "EXPIRED"].includes(topup.status)) return { duplicate: true, status: topup.status };

      if (event.status === "EXPIRED") {
        await tx.update(topups).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(topups.id, topup.id));
        await tx.insert(auditLogs).values({ actorType: "SYSTEM", action: "TOPUP_PAYMENT_EXPIRED", entityType: "topup", entityId: topup.id, newValue: { eventId: event.eventId, status: event.status }, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent });
        return { duplicate: false, status: "EXPIRED" };
      }
      if (event.status === "FAILED") {
        await tx.update(topups).set({ status: "FAILED", updatedAt: new Date() }).where(eq(topups.id, topup.id));
        await tx.insert(auditLogs).values({ actorType: "SYSTEM", action: "TOPUP_PAYMENT_FAILED", entityType: "topup", entityId: topup.id, newValue: { eventId: event.eventId, status: event.status }, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent });
        return { duplicate: false, status: "FAILED" };
      }
      if (event.status === "PROCESSING") {
        if (topup.status === "PENDING") await tx.update(topups).set({ status: "PROCESSING", updatedAt: new Date() }).where(eq(topups.id, topup.id));
        return { duplicate: false, status: "PROCESSING" };
      }

      await tx.execute(sql`SELECT id FROM wallets WHERE id = ${topup.walletId} FOR UPDATE`);
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, topup.walletId)).limit(1);
      if (!wallet) throw new ApiError("Wallet top-up tidak ditemukan.", "WALLET_NOT_FOUND", 404);
      const ledgerKey = `TOPUP-${topup.id}`;
      const [previousLedger] = await tx.select({ id: walletTransactions.id }).from(walletTransactions).where(eq(walletTransactions.idempotencyKey, ledgerKey)).limit(1);
      if (previousLedger) {
        await tx.update(topups).set({ status: "SUCCESS", paidAt: topup.paidAt ?? new Date(), updatedAt: new Date() }).where(eq(topups.id, topup.id));
        return { duplicate: true, status: "SUCCESS" };
      }
      const now = new Date();
      const availableAfter = wallet.availableBalance + topup.amount;
      await tx.update(wallets).set({ availableBalance: availableAfter, updatedAt: now }).where(eq(wallets.id, wallet.id));
      await tx.insert(walletTransactions).values({ walletId: wallet.id, userId: topup.userId, type: "TOPUP", direction: "CREDIT", amount: topup.amount, availableBefore: wallet.availableBalance, availableAfter, lockedBefore: wallet.lockedBalance, lockedAfter: wallet.lockedBalance, pendingBefore: wallet.pendingBalance, pendingAfter: wallet.pendingBalance, referenceType: "topup", referenceId: topup.id, description: "Top-up terverifikasi oleh Midtrans", idempotencyKey: ledgerKey });
      await tx.update(topups).set({ status: "SUCCESS", paidAt: now, updatedAt: now }).where(eq(topups.id, topup.id));
      await tx.insert(notifications).values({ userId: topup.userId, title: "Top-up berhasil", message: `Saldo tersedia bertambah Rp${topup.amount.toLocaleString("id-ID")}.`, type: "TOPUP_SUCCESS", referenceType: "topup", referenceId: topup.id });
      await tx.insert(auditLogs).values({ actorType: "SYSTEM", action: "TOPUP_PAYMENT_VERIFIED", entityType: "topup", entityId: topup.id, newValue: { amount: topup.amount, eventId: event.eventId, provider: event.provider, status: "SUCCESS" }, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent });
      return { duplicate: false, status: "SUCCESS" };
    });
    return jsonOk(result, result.duplicate ? "Webhook duplikat telah diabaikan." : "Webhook diproses.");
  } catch (error) { return errorResponse(error); }
}
