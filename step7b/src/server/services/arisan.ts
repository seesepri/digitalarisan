import { randomBytes, randomInt } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  arisanParticipants,
  arisanPeriods,
  arisanTypes,
  auditLogs,
  drawAuthorizations,
  drawings,
  financialAccounts,
  financialTransactions,
  notifications,
  payouts,
  payoutAttempts,
  platformFees,
  userRoleEnum,
  users,
  walletReservations,
  walletTransactions,
  wallets,
  winners,
} from "@/db/schema";
import { ApiError } from "@/server/http";

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function assertJoinReplay(tx: Transaction, previous: typeof walletTransactions.$inferSelect, input: { userId: string; periodId: string }) {
  const [participant] = previous.referenceId ? await tx.select({ periodId: arisanParticipants.periodId }).from(arisanParticipants).where(eq(arisanParticipants.id, previous.referenceId)).limit(1) : [];
  if (previous.userId !== input.userId || previous.type !== "JOIN_ARISAN" || previous.referenceType !== "arisan_participant" || participant?.periodId !== input.periodId) throw new ApiError("Idempotency key telah digunakan untuk operasi/periode lain.", "IDEMPOTENCY_CONFLICT", 409);
}

export async function joinPeriod(input: {
  periodId: string;
  userId: string;
  idempotencyKey: string;
  meta?: RequestMeta;
}) {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (previous) {
      await assertJoinReplay(tx, previous, input);
      return { participantId: previous.referenceId, replayed: true };
    }

    await tx.execute(sql`SELECT id FROM arisan_periods WHERE id = ${input.periodId} FOR UPDATE`);
    const [afterLock] = await tx.select().from(walletTransactions).where(eq(walletTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
    if (afterLock) {
      await assertJoinReplay(tx, afterLock, input);
      return { participantId: afterLock.referenceId, replayed: true };
    }
    const [period] = await tx.select().from(arisanPeriods).where(eq(arisanPeriods.id, input.periodId)).limit(1);
    if (!period) throw new ApiError("Periode arisan tidak ditemukan.", "PERIOD_NOT_FOUND", 404);
    const now = new Date();
    if (period.status !== "OPEN" && period.status !== "FULL") {
      throw new ApiError("Periode ini tidak menerima peserta baru.", "PERIOD_NOT_OPEN", 409);
    }
    if (now < period.registrationStartsAt || now > period.registrationEndsAt) {
      throw new ApiError("Masa pendaftaran periode ini belum dibuka atau telah berakhir.", "REGISTRATION_CLOSED", 409);
    }

    const [existingParticipant] = await tx
      .select({ id: arisanParticipants.id, status: arisanParticipants.status })
      .from(arisanParticipants)
      .where(and(eq(arisanParticipants.periodId, input.periodId), eq(arisanParticipants.userId, input.userId)))
      .limit(1);
    if (existingParticipant) {
      throw new ApiError(
        existingParticipant.status === "ACTIVE" ? "Anda sudah terdaftar pada periode ini." : "Kepesertaan periode ini tidak dapat dibuat ulang.",
        "ALREADY_PARTICIPATING",
        409,
      );
    }

    const activeParticipants = await tx
      .select({ id: arisanParticipants.id })
      .from(arisanParticipants)
      .where(and(eq(arisanParticipants.periodId, input.periodId), eq(arisanParticipants.status, "ACTIVE")));
    if (activeParticipants.length >= period.maximumParticipants) {
      throw new ApiError("Kuota peserta sudah penuh.", "PERIOD_FULL", 409);
    }

    await tx.execute(sql`SELECT id FROM wallets WHERE user_id = ${input.userId} FOR UPDATE`);
    const [afterWalletLock] = await tx.select().from(walletTransactions).where(eq(walletTransactions.idempotencyKey, input.idempotencyKey)).limit(1);
    if (afterWalletLock) { await assertJoinReplay(tx, afterWalletLock, input); return { participantId: afterWalletLock.referenceId, replayed: true }; }
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, input.userId)).limit(1);
    if (!wallet) throw new ApiError("Wallet pengguna tidak ditemukan.", "WALLET_NOT_FOUND", 404);
    if (wallet.availableBalance < period.contributionAmount) {
      throw new ApiError("Saldo tersedia tidak mencukupi.", "INSUFFICIENT_BALANCE", 409);
    }

    const [participant] = await tx
      .insert(arisanParticipants)
      .values({
        periodId: period.id,
        userId: input.userId,
        contributionAmount: period.contributionAmount,
        status: "ACTIVE",
        joinedAt: now,
        lockedAt: now,
        eligibleForDrawing: true,
      })
      .returning({ id: arisanParticipants.id });
    await tx
      .insert(financialAccounts)
      .values({
        code: `ARISAN_POOL:${period.id}`,
        type: "ARISAN_POOL",
        periodId: period.id,
        balance: 0,
      })
      .onConflictDoNothing({ target: financialAccounts.code });
    await tx.insert(walletReservations).values({
      walletId: wallet.id,
      userId: input.userId,
      participantId: participant.id,
      periodId: period.id,
      amount: period.contributionAmount,
      status: "ACTIVE",
    });
    const availableAfter = wallet.availableBalance - period.contributionAmount;
    const lockedAfter = wallet.lockedBalance + period.contributionAmount;
    await tx
      .update(wallets)
      .set({ availableBalance: availableAfter, lockedBalance: lockedAfter, updatedAt: now })
      .where(eq(wallets.id, wallet.id));
    const [activeReservationTotal] = await tx
      .select({ total: sql<number>`COALESCE(SUM(${walletReservations.amount}), 0)` })
      .from(walletReservations)
      .where(and(eq(walletReservations.walletId, wallet.id), eq(walletReservations.status, "ACTIVE")));
    if (Number(activeReservationTotal?.total ?? 0) !== lockedAfter) {
      throw new ApiError("lockedBalance tidak sama dengan total reservation aktif.", "WALLET_RESERVATION_BALANCE_MISMATCH", 500);
    }
    await tx.insert(walletTransactions).values({
      walletId: wallet.id,
      userId: input.userId,
      type: "JOIN_ARISAN",
      direction: "DEBIT",
      amount: period.contributionAmount,
      availableBefore: wallet.availableBalance,
      availableAfter,
      lockedBefore: wallet.lockedBalance,
      lockedAfter,
      pendingBefore: wallet.pendingBalance,
      pendingAfter: wallet.pendingBalance,
      referenceType: "arisan_participant",
      referenceId: participant.id,
      description: `Iuran dikunci untuk ${period.code}`,
      idempotencyKey: input.idempotencyKey,
    });

    const type = await tx.select({ name: arisanTypes.name }).from(arisanTypes).where(eq(arisanTypes.id, period.typeId)).limit(1);
    await tx.insert(notifications).values({
      userId: input.userId,
      title: "Berhasil bergabung",
      message: `Iuran ${formatRupiah(period.contributionAmount)} telah dikunci untuk ${type[0]?.name ?? period.code}.`,
      type: "ARISAN_JOINED",
      referenceType: "arisan_period",
      referenceId: period.id,
    });
    await tx.insert(auditLogs).values({
      actorId: input.userId,
      actorType: "USER",
      action: "ARISAN_JOINED",
      entityType: "arisan_participant",
      entityId: participant.id,
      newValue: { periodId: period.id, contributionAmount: period.contributionAmount },
      ipAddress: input.meta?.ipAddress ?? null,
      userAgent: input.meta?.userAgent ?? null,
    });
    if (activeParticipants.length + 1 >= period.maximumParticipants) {
      await tx.update(arisanPeriods).set({ status: "FULL", updatedAt: now }).where(eq(arisanPeriods.id, period.id));
    }
    return { participantId: participant.id, replayed: false };
  });
}

export async function cancelParticipation(input: {
  participantId: string;
  userId: string;
  idempotencyKey: string;
  meta?: RequestMeta;
}) {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (previous) {
      if (previous.userId !== input.userId || previous.type !== "CANCEL_ARISAN" || previous.referenceId !== input.participantId) {
        throw new ApiError("Idempotency key telah digunakan untuk operasi lain.", "IDEMPOTENCY_CONFLICT", 409);
      }
      return { participantId: previous.referenceId, refunded: true, replayed: true };
    }

    const [unlockedParticipant] = await tx
      .select({ periodId: arisanParticipants.periodId })
      .from(arisanParticipants)
      .where(and(eq(arisanParticipants.id, input.participantId), eq(arisanParticipants.userId, input.userId)))
      .limit(1);
    if (!unlockedParticipant) throw new ApiError("Kepesertaan tidak ditemukan.", "PARTICIPANT_NOT_FOUND", 404);
    await tx.execute(sql`SELECT id FROM arisan_periods WHERE id = ${unlockedParticipant.periodId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM arisan_participants WHERE id = ${input.participantId} FOR UPDATE`);
    const [afterLockIdempotency] = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (afterLockIdempotency) {
      if (afterLockIdempotency.userId !== input.userId || afterLockIdempotency.type !== "CANCEL_ARISAN") {
        throw new ApiError("Idempotency key telah digunakan untuk operasi lain.", "IDEMPOTENCY_CONFLICT", 409);
      }
      return { participantId: afterLockIdempotency.referenceId, refunded: true, replayed: true };
    }

    const [participant] = await tx
      .select()
      .from(arisanParticipants)
      .where(and(eq(arisanParticipants.id, input.participantId), eq(arisanParticipants.userId, input.userId)))
      .limit(1);
    if (!participant) throw new ApiError("Kepesertaan tidak ditemukan.", "PARTICIPANT_NOT_FOUND", 404);
    if (participant.status === "CANCELLED") {
      throw new ApiError("Kepesertaan sudah dibatalkan oleh permintaan sebelumnya.", "ALREADY_CANCELLED", 409);
    }
    if (participant.status !== "ACTIVE") throw new ApiError("Kepesertaan sudah diselesaikan dan tidak dapat dibatalkan.", "CANCELLATION_NOT_ALLOWED", 409);

    const [period] = await tx.select().from(arisanPeriods).where(eq(arisanPeriods.id, participant.periodId)).limit(1);
    if (!period) throw new ApiError("Periode arisan tidak ditemukan.", "PERIOD_NOT_FOUND", 404);
    if (new Date() > period.cancellationDeadlineAt) {
      throw new ApiError("Batas pembatalan telah berakhir.", "CANCELLATION_DEADLINE_PASSED", 409);
    }
    if (["DRAWING", "PAYOUT_PROCESSING", "COMPLETED", "CANCELLED"].includes(period.status)) {
      throw new ApiError("Periode sudah memasuki proses drawing atau penyelesaian.", "CANCELLATION_NOT_ALLOWED", 409);
    }

    await tx.execute(sql`SELECT id FROM wallets WHERE user_id = ${input.userId} FOR UPDATE`);
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, input.userId)).limit(1);
    if (!wallet || wallet.lockedBalance < participant.contributionAmount) {
      throw new ApiError("Saldo terkunci tidak sesuai dengan data kepesertaan.", "WALLET_INTEGRITY_ERROR", 500);
    }
    await tx.execute(sql`SELECT id FROM wallet_reservations WHERE participant_id = ${participant.id} FOR UPDATE`);
    const [reservation] = await tx.select().from(walletReservations).where(eq(walletReservations.participantId, participant.id)).limit(1);
    if (!reservation || reservation.status !== "ACTIVE" || reservation.walletId !== wallet.id || reservation.amount !== participant.contributionAmount) {
      throw new ApiError("Reservation dana peserta tidak sesuai.", "WALLET_RESERVATION_INTEGRITY_ERROR", 500);
    }
    const now = new Date();
    const availableAfter = wallet.availableBalance + participant.contributionAmount;
    const lockedAfter = wallet.lockedBalance - participant.contributionAmount;
    await tx.update(walletReservations).set({ status: "RELEASED", releasedAt: now }).where(eq(walletReservations.id, reservation.id));
    await tx.update(wallets).set({ availableBalance: availableAfter, lockedBalance: lockedAfter, updatedAt: now }).where(eq(wallets.id, wallet.id));
    const [activeReservationTotal] = await tx
      .select({ total: sql<number>`COALESCE(SUM(${walletReservations.amount}), 0)` })
      .from(walletReservations)
      .where(and(eq(walletReservations.walletId, wallet.id), eq(walletReservations.status, "ACTIVE")));
    if (Number(activeReservationTotal?.total ?? 0) !== lockedAfter) {
      throw new ApiError("lockedBalance tidak sama dengan total reservation aktif.", "WALLET_RESERVATION_BALANCE_MISMATCH", 500);
    }
    await tx.update(arisanParticipants).set({ status: "CANCELLED", cancelledAt: now, eligibleForDrawing: false, updatedAt: now }).where(eq(arisanParticipants.id, participant.id));
    await tx.insert(walletTransactions).values({
      walletId: wallet.id,
      userId: input.userId,
      type: "CANCEL_ARISAN",
      direction: "CREDIT",
      amount: participant.contributionAmount,
      availableBefore: wallet.availableBalance,
      availableAfter,
      lockedBefore: wallet.lockedBalance,
      lockedAfter,
      pendingBefore: wallet.pendingBalance,
      pendingAfter: wallet.pendingBalance,
      referenceType: "arisan_participant",
      referenceId: participant.id,
      description: `Pengembalian iuran ${period.code}`,
      idempotencyKey: input.idempotencyKey,
    });
    const [type] = await tx.select({ name: arisanTypes.name }).from(arisanTypes).where(eq(arisanTypes.id, period.typeId)).limit(1);
    await tx.insert(notifications).values({
      userId: input.userId,
      title: "Kepesertaan dibatalkan",
      message: `${formatRupiah(participant.contributionAmount)} telah dikembalikan ke saldo tersedia.`,
      type: "ARISAN_CANCELLED",
      referenceType: "arisan_period",
      referenceId: period.id,
    });
    await tx.insert(auditLogs).values({
      actorId: input.userId,
      actorType: "USER",
      action: "ARISAN_CANCELLED",
      entityType: "arisan_participant",
      entityId: participant.id,
      oldValue: { status: participant.status },
      newValue: { status: "CANCELLED", refundAmount: participant.contributionAmount },
      ipAddress: input.meta?.ipAddress ?? null,
      userAgent: input.meta?.userAgent ?? null,
    });
    const remaining = await tx
      .select({ id: arisanParticipants.id })
      .from(arisanParticipants)
      .where(and(eq(arisanParticipants.periodId, period.id), eq(arisanParticipants.status, "ACTIVE")));
    if (period.status === "FULL" && remaining.length < period.maximumParticipants) {
      await tx.update(arisanPeriods).set({ status: "OPEN", updatedAt: now }).where(eq(arisanPeriods.id, period.id));
    }
    return { participantId: participant.id, refunded: true, replayed: false, arisanName: type?.name ?? period.code };
  });
}

export async function requestDrawAuthorization(input: {
  periodId: string;
  actorId: string;
  actorRole: "ADMIN" | "SUPER_ADMIN";
  reason: string;
  meta?: RequestMeta;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM arisan_periods WHERE id = ${input.periodId} FOR UPDATE`);
    const [period] = await tx.select({ id: arisanPeriods.id, status: arisanPeriods.status, drawingAt: arisanPeriods.drawingAt }).from(arisanPeriods).where(eq(arisanPeriods.id, input.periodId)).limit(1);
    if (!period) throw new ApiError("Periode arisan tidak ditemukan.", "PERIOD_NOT_FOUND", 404);
    if (["COMPLETED", "CANCELLED", "DRAWING", "PAYOUT_PROCESSING"].includes(period.status)) throw new ApiError("Periode sedang atau sudah diproses.", "PERIOD_ALREADY_SETTLED", 409);
    if (new Date() < period.drawingAt) throw new ApiError("Drawing belum mencapai waktu yang ditentukan.", "DRAWING_TOO_EARLY", 409);
    const [existing] = await tx.select().from(drawAuthorizations).where(eq(drawAuthorizations.periodId, input.periodId)).limit(1);
    if (existing) return { authorization: existing, replayed: true };
    const now = new Date();
    const [authorization] = await tx.insert(drawAuthorizations).values({ periodId: input.periodId, requestedBy: input.actorId, requestedAt: now, status: "REQUESTED", requestReason: input.reason }).returning();
    await tx.insert(auditLogs).values({ actorId: input.actorId, actorType: input.actorRole, action: "ARISAN_DRAW_AUTHORIZATION_REQUESTED", entityType: "arisan_period", entityId: input.periodId, newValue: { authorizationId: authorization.id, reason: input.reason }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
    return { authorization, replayed: false };
  });
}

export async function approveDrawAuthorization(input: {
  periodId: string;
  actorId: string;
  actorRole: "ADMIN" | "SUPER_ADMIN";
  reason: string;
  meta?: RequestMeta;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM draw_authorizations WHERE period_id = ${input.periodId} FOR UPDATE`);
    const [authorization] = await tx.select().from(drawAuthorizations).where(eq(drawAuthorizations.periodId, input.periodId)).limit(1);
    if (!authorization) throw new ApiError("Otorisasi drawing belum diminta.", "DRAW_AUTHORIZATION_REQUIRED", 409);
    if (authorization.status === "EXECUTED") return { authorization, replayed: true };
    if (authorization.status === "APPROVED") {
      if (authorization.approvedBy !== input.actorId) throw new ApiError("Drawing sudah disetujui checker lain.", "DRAW_AUTHORIZATION_ALREADY_APPROVED", 409);
      return { authorization, replayed: true };
    }
    if (authorization.status !== "REQUESTED") throw new ApiError("Otorisasi drawing tidak berada pada status REQUESTED.", "DRAW_AUTHORIZATION_INVALID_STATE", 409);
    if (authorization.requestedBy === input.actorId) throw new ApiError("Maker-checker: pembuat permintaan tidak boleh menyetujui drawing yang sama.", "MAKER_CHECKER_SEPARATION_REQUIRED", 403);
    const now = new Date();
    const [updated] = await tx.update(drawAuthorizations).set({ status: "APPROVED", approvedBy: input.actorId, approvedAt: now, approvalReason: input.reason, updatedAt: now }).where(eq(drawAuthorizations.id, authorization.id)).returning();
    await tx.insert(auditLogs).values({ actorId: input.actorId, actorType: input.actorRole, action: "ARISAN_DRAW_AUTHORIZATION_APPROVED", entityType: "arisan_period", entityId: input.periodId, oldValue: { status: authorization.status, requestedBy: authorization.requestedBy }, newValue: { status: "APPROVED", authorizationId: authorization.id, approvedBy: input.actorId, reason: input.reason }, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
    return { authorization: updated, replayed: false };
  });
}

export async function drawAndSettle(input: { periodId: string; actorId?: string | null; actorType: string; meta?: RequestMeta }) {
  return db.transaction(async (tx) => {
    // Phase 1: lock and validate the period so only one settlement can run.
    await tx.execute(sql`SELECT id FROM arisan_periods WHERE id = ${input.periodId} FOR UPDATE`);
    const [period] = await tx.select().from(arisanPeriods).where(eq(arisanPeriods.id, input.periodId)).limit(1);
    if (!period) throw new ApiError("Periode arisan tidak ditemukan.", "PERIOD_NOT_FOUND", 404);
    if (["COMPLETED", "CANCELLED", "DRAWING", "PAYOUT_PROCESSING"].includes(period.status)) {
      throw new ApiError("Periode sedang atau sudah diproses.", "PERIOD_ALREADY_SETTLED", 409);
    }

    const now = new Date();
    if (now < period.cancellationDeadlineAt || now < period.drawingAt) {
      throw new ApiError("Drawing hanya dapat dilakukan setelah batas pembatalan dan waktu drawing.", "DRAWING_TOO_EARLY", 409);
    }

    if (input.actorType !== "SYSTEM") {
      if (!input.actorId || !["ADMIN", "SUPER_ADMIN"].includes(input.actorType)) throw new ApiError("Drawing manual harus menggunakan identitas administrator yang sah.", "DRAW_AUTHORIZATION_REQUIRED", 403);
      await tx.execute(sql`SELECT id FROM draw_authorizations WHERE period_id = ${period.id} FOR UPDATE`);
      const [authorization] = await tx.select().from(drawAuthorizations).where(eq(drawAuthorizations.periodId, period.id)).limit(1);
      if (!authorization || authorization.status !== "APPROVED" || !authorization.approvedBy) throw new ApiError("Drawing manual memerlukan otorisasi maker-checker yang telah disetujui.", "DRAW_AUTHORIZATION_REQUIRED", 403);
      if (authorization.approvedBy !== input.actorId || authorization.requestedBy === input.actorId) throw new ApiError("Checker yang menyetujui harus menjadi executor dan berbeda dari maker.", "MAKER_CHECKER_SEPARATION_REQUIRED", 403);
      await tx.update(drawAuthorizations).set({ status: "EXECUTING", updatedAt: now }).where(eq(drawAuthorizations.id, authorization.id));
    }

    const active = await tx
      .select()
      .from(arisanParticipants)
      .where(and(eq(arisanParticipants.periodId, period.id), eq(arisanParticipants.status, "ACTIVE"), eq(arisanParticipants.eligibleForDrawing, true)))
      .orderBy(arisanParticipants.joinedAt, arisanParticipants.id);

    // Phase 2: if the minimum participant count is not reached, release every reservation atomically.
    if (active.length < period.minimumParticipants) {
      for (const participant of active) {
        await tx.execute(sql`SELECT id FROM wallets WHERE user_id = ${participant.userId} FOR UPDATE`);
        const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, participant.userId)).limit(1);
        if (!wallet || wallet.lockedBalance < participant.contributionAmount) {
          throw new ApiError("Saldo terkunci tidak sesuai untuk refund periode.", "WALLET_INTEGRITY_ERROR", 500);
        }

        await tx.execute(sql`SELECT id FROM wallet_reservations WHERE participant_id = ${participant.id} FOR UPDATE`);
        const [reservation] = await tx.select().from(walletReservations).where(eq(walletReservations.participantId, participant.id)).limit(1);
        if (!reservation || reservation.status !== "ACTIVE" || reservation.walletId !== wallet.id || reservation.amount !== participant.contributionAmount) {
          throw new ApiError("Reservation dana peserta tidak sesuai untuk refund.", "WALLET_RESERVATION_INTEGRITY_ERROR", 500);
        }

        const availableAfter = wallet.availableBalance + participant.contributionAmount;
        const lockedAfter = wallet.lockedBalance - participant.contributionAmount;
        await tx.update(walletReservations).set({ status: "RELEASED", releasedAt: now }).where(eq(walletReservations.id, reservation.id));
        await tx.update(wallets).set({ availableBalance: availableAfter, lockedBalance: lockedAfter, updatedAt: now }).where(eq(wallets.id, wallet.id));

        const [activeReservationTotal] = await tx
          .select({ total: sql<number>`COALESCE(SUM(${walletReservations.amount}), 0)` })
          .from(walletReservations)
          .where(and(eq(walletReservations.walletId, wallet.id), eq(walletReservations.status, "ACTIVE")));
        if (Number(activeReservationTotal?.total ?? 0) !== lockedAfter) {
          throw new ApiError("lockedBalance tidak sama dengan total reservation aktif.", "WALLET_RESERVATION_BALANCE_MISMATCH", 500);
        }

        await tx.update(arisanParticipants).set({ status: "CANCELLED", cancelledAt: now, eligibleForDrawing: false, updatedAt: now }).where(eq(arisanParticipants.id, participant.id));
        await tx.insert(walletTransactions).values({
          walletId: wallet.id,
          userId: participant.userId,
          type: "REFUND",
          direction: "CREDIT",
          amount: participant.contributionAmount,
          availableBefore: wallet.availableBalance,
          availableAfter,
          lockedBefore: wallet.lockedBalance,
          lockedAfter,
          pendingBefore: wallet.pendingBalance,
          pendingAfter: wallet.pendingBalance,
          referenceType: "arisan_period",
          referenceId: period.id,
          description: `Refund otomatis karena peserta minimum tidak tercapai (${period.code})`,
          idempotencyKey: `REFUND-${period.id}-${participant.id}`,
        });
        await tx.insert(notifications).values({
          userId: participant.userId,
          title: "Periode dibatalkan",
          message: `Peserta minimum tidak tercapai. ${formatRupiah(participant.contributionAmount)} dikembalikan ke saldo tersedia.`,
          type: "ARISAN_REFUND",
          referenceType: "arisan_period",
          referenceId: period.id,
        });
      }

      await tx.update(arisanPeriods).set({ status: "CANCELLED", updatedAt: now }).where(eq(arisanPeriods.id, period.id));
      if (input.actorType !== "SYSTEM") await tx.update(drawAuthorizations).set({ status: "EXECUTED", executedAt: now, updatedAt: now }).where(eq(drawAuthorizations.periodId, period.id));
      await tx.insert(auditLogs).values({
        actorId: input.actorId ?? null,
        actorType: input.actorType,
        action: "ARISAN_PERIOD_CANCELLED_MINIMUM_NOT_MET",
        entityType: "arisan_period",
        entityId: period.id,
        newValue: { activeParticipants: active.length, minimumParticipants: period.minimumParticipants, refundedCount: active.length },
        ipAddress: input.meta?.ipAddress ?? null,
        userAgent: input.meta?.userAgent ?? null,
      });
      return { status: "CANCELLED" as const, refundedCount: active.length };
    }

    // Phase 3: calculate the immutable settlement amounts before changing any balances.
    const winnerParticipant = active[randomInt(active.length)];
    const grossAmount = active.reduce((sum, participant) => sum + participant.contributionAmount, 0);
    if (!Number.isSafeInteger(grossAmount) || grossAmount <= 0) {
      throw new ApiError("Nilai dana periode tidak valid.", "INVALID_POOL_AMOUNT", 500);
    }
    const feeProduct = grossAmount * period.platformFeeBps;
    if (!Number.isSafeInteger(feeProduct)) {
      throw new ApiError("Nilai fee settlement tidak aman untuk diproses.", "INVALID_SETTLEMENT_AMOUNT", 500);
    }
    const feeAmount = Math.floor(feeProduct / 10_000);
    const netAmount = grossAmount - feeAmount;
    if (!Number.isSafeInteger(feeAmount) || !Number.isSafeInteger(netAmount) || netAmount <= 0) {
      throw new ApiError("Nilai payout bersih tidak valid.", "INVALID_PAYOUT_AMOUNT", 500);
    }

    // Phase 4: record the drawing and payout intent before posting accounting entries.
    await tx.update(arisanPeriods).set({ status: "DRAWING", updatedAt: now }).where(eq(arisanPeriods.id, period.id));
    const randomReference = randomBytes(24).toString("hex");
    const [drawing] = await tx.insert(drawings).values({
      periodId: period.id,
      selectionMethod: "NODE_CRYPTO_RANDOM_INT",
      eligibleParticipantCount: active.length,
      selectedParticipantId: winnerParticipant.id,
      randomReference,
      executedAt: now,
      executedBy: input.actorId ?? null,
      status: "SUCCESS",
    }).returning({ id: drawings.id });

    await tx.update(arisanParticipants).set({ status: "WINNER", updatedAt: now }).where(eq(arisanParticipants.id, winnerParticipant.id));
    const [winner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, winnerParticipant.userId)).limit(1);
    await tx.insert(winners).values({
      periodId: period.id,
      participantId: winnerParticipant.id,
      userId: winnerParticipant.userId,
      prizeAmount: netAmount,
    });
    await tx.update(arisanPeriods).set({ status: "PAYOUT_PROCESSING", updatedAt: now }).where(eq(arisanPeriods.id, period.id));

    const payoutKey = `PAYOUT-${period.id}`;
    const [payout] = await tx.insert(payouts).values({
      periodId: period.id,
      userId: winnerParticipant.userId,
      grossAmount,
      feeAmount,
      netAmount,
      idempotencyKey: payoutKey,
      status: "PROCESSING",
    }).returning({ id: payouts.id });
    await tx.update(payouts).set({ attemptCount: 1, updatedAt: now }).where(eq(payouts.id, payout.id));
    await tx.insert(payoutAttempts).values({
      payoutId: payout.id, attemptNumber: 1, fromStatus: "PENDING", toStatus: "PROCESSING",
      idempotencyKey: `${payoutKey}-ATTEMPT-1-PROCESSING`,
    });

    // Phase 5: resolve and lock the system accounting accounts.
    const getOrCreateAccount = async (code: string, type: "ARISAN_POOL" | "PLATFORM_FEE", periodId: string | null) => {
      const [created] = await tx.insert(financialAccounts).values({
        code,
        type,
        periodId,
        balance: 0,
      }).onConflictDoNothing({ target: financialAccounts.code }).returning({ id: financialAccounts.id });
      const [account] = created
        ? [created]
        : await tx.select({ id: financialAccounts.id }).from(financialAccounts).where(eq(financialAccounts.code, code)).limit(1);
      if (!account) throw new ApiError(`Akun accounting ${code} tidak ditemukan.`, "ACCOUNTING_ACCOUNT_NOT_FOUND", 500);
      await tx.execute(sql`SELECT id FROM financial_accounts WHERE id = ${account.id} FOR UPDATE`);
      const [locked] = await tx.select().from(financialAccounts).where(eq(financialAccounts.id, account.id)).limit(1);
      if (!locked) throw new ApiError(`Akun accounting ${code} tidak tersedia.`, "ACCOUNTING_ACCOUNT_NOT_FOUND", 500);
      return locked;
    };

    const poolAccount = await getOrCreateAccount(`ARISAN_POOL:${period.id}`, "ARISAN_POOL", period.id);
    const feeAccount = await getOrCreateAccount("PLATFORM_FEE", "PLATFORM_FEE", null);
    if (poolAccount.balance !== 0) {
      throw new ApiError("Saldo pool periode sudah terisi sebelum settlement.", "SETTLEMENT_POOL_NOT_EMPTY", 409);
    }

    // Phase 6: move every active wallet reservation into the period settlement pool.
    // Participants are processed in deterministic userId order to minimize lock inversion/deadlock risk.
    let poolBalance = poolAccount.balance;
    const participantsByUser = [...active].sort((a, b) => a.userId.localeCompare(b.userId));
    const participantIds = participantsByUser.map((participant) => participant.id);
    const participantUserIds = participantsByUser.map((participant) => participant.userId);
    const lockedWallets = await tx.select().from(wallets)
      .where(inArray(wallets.userId, participantUserIds))
      .orderBy(wallets.userId)
      .for("update");
    const walletsByUser = new Map(lockedWallets.map((wallet) => [wallet.userId, wallet]));
    const lockedReservations = await tx.select().from(walletReservations)
      .where(inArray(walletReservations.participantId, participantIds))
      .orderBy(walletReservations.participantId)
      .for("update");
    const reservationsByParticipant = new Map(lockedReservations.map((reservation) => [reservation.participantId, reservation]));
    const activeReservationTotals = await tx.select({
      walletId: walletReservations.walletId,
      total: sql<number>`COALESCE(SUM(${walletReservations.amount}), 0)`,
    }).from(walletReservations)
      .where(and(inArray(walletReservations.walletId, lockedWallets.map((wallet) => wallet.id)), eq(walletReservations.status, "ACTIVE")))
      .groupBy(walletReservations.walletId);
    const reservationTotalByWallet = new Map(activeReservationTotals.map((item) => [item.walletId, Number(item.total)]));
    const settlementRows = participantsByUser.map((participant) => {
      const reservation = reservationsByParticipant.get(participant.id);
      const wallet = walletsByUser.get(participant.userId);
      if (!reservation || reservation.status !== "ACTIVE" || reservation.amount !== participant.contributionAmount) {
        throw new ApiError("Reservation dana tidak sesuai pada settlement.", "WALLET_RESERVATION_INTEGRITY_ERROR", 500);
      }
      if (!wallet || wallet.userId !== participant.userId || wallet.lockedBalance < reservation.amount) {
        throw new ApiError("Saldo terkunci tidak sesuai pada settlement.", "WALLET_INTEGRITY_ERROR", 500);
      }
      const lockedAfter = wallet.lockedBalance - reservation.amount;
      const activeReservationsAfter = (reservationTotalByWallet.get(wallet.id) ?? 0) - reservation.amount;
      if (activeReservationsAfter !== lockedAfter) {
        throw new ApiError("lockedBalance tidak sama dengan total reservation aktif.", "WALLET_RESERVATION_BALANCE_MISMATCH", 500);
      }
      return { participant, reservation, wallet, lockedAfter };
    });
    const consumedReservations = await tx.update(walletReservations)
      .set({ status: "CONSUMED", consumedAt: now })
      .where(and(inArray(walletReservations.participantId, participantIds), eq(walletReservations.status, "ACTIVE")))
      .returning({ participantId: walletReservations.participantId });
    if (consumedReservations.length !== settlementRows.length) {
      throw new ApiError("Jumlah reservation yang dikonsumsi tidak sesuai dengan peserta aktif.", "WALLET_RESERVATION_INTEGRITY_ERROR", 500);
    }
    const walletUpdateRows = settlementRows.map(({ wallet, lockedAfter }) => sql`(${wallet.id}::uuid, ${lockedAfter}::bigint)`);
    if (walletUpdateRows.length) {
      await tx.execute(sql`
        UPDATE wallets AS target
        SET locked_balance = changes.locked_balance, updated_at = ${now}
        FROM (VALUES ${sql.join(walletUpdateRows, sql`, `)}) AS changes(id, locked_balance)
        WHERE target.id = changes.id
      `);
    }
    const walletLedgerEntries: Array<typeof walletTransactions.$inferInsert> = [];
    const financialLedgerEntries: Array<typeof financialTransactions.$inferInsert> = [];
    for (const { participant, reservation, wallet, lockedAfter } of settlementRows) {
      const activeReservationsAfter = (reservationTotalByWallet.get(wallet.id) ?? 0) - reservation.amount;
      reservationTotalByWallet.set(wallet.id, activeReservationsAfter);

      walletLedgerEntries.push({
        walletId: wallet.id,
        userId: participant.userId,
        type: "PAYOUT",
        direction: "DEBIT",
        amount: reservation.amount,
        availableBefore: wallet.availableBalance,
        availableAfter: wallet.availableBalance,
        lockedBefore: wallet.lockedBalance,
        lockedAfter,
        pendingBefore: wallet.pendingBalance,
        pendingAfter: wallet.pendingBalance,
        referenceType: "payout",
        referenceId: payout.id,
        description: `Transfer iuran ke settlement pool ${period.code}`,
        idempotencyKey: `${payoutKey}-POOL-CREDIT-${participant.id}`,
      });

      const poolAfter = poolBalance + reservation.amount;
      financialLedgerEntries.push({
        accountId: poolAccount.id,
        direction: "CREDIT",
        amount: reservation.amount,
        balanceBefore: poolBalance,
        balanceAfter: poolAfter,
        referenceType: "payout",
        referenceId: payout.id,
        description: `Penerimaan iuran dari wallet peserta ${participant.userId}`,
        idempotencyKey: `${payoutKey}-POOL-CREDIT-${participant.id}`,
      });
      poolBalance = poolAfter;
    }
    if (walletLedgerEntries.length) await tx.insert(walletTransactions).values(walletLedgerEntries);
    if (financialLedgerEntries.length) await tx.insert(financialTransactions).values(financialLedgerEntries);
    await tx.update(financialAccounts).set({ balance: poolBalance, updatedAt: now }).where(eq(financialAccounts.id, poolAccount.id));

    // Phase 7: enforce the core accounting invariant before any outgoing settlement transfer.
    if (poolBalance !== grossAmount) {
      throw new ApiError("Saldo settlement pool tidak sama dengan total kontribusi.", "SETTLEMENT_POOL_MISMATCH", 500);
    }
    if (feeAmount + netAmount !== grossAmount) {
      throw new ApiError("Komponen settlement tidak seimbang dengan gross amount.", "SETTLEMENT_AMOUNT_MISMATCH", 500);
    }

    // Phase 8: transfer net payout from the pool to the winner wallet.
    const poolAfterWinner = poolBalance - netAmount;
    if (poolAfterWinner < 0) throw new ApiError("Saldo settlement pool tidak cukup untuk payout winner.", "SETTLEMENT_POOL_INSUFFICIENT", 500);
    await tx.update(financialAccounts).set({ balance: poolAfterWinner, updatedAt: now }).where(eq(financialAccounts.id, poolAccount.id));
    await tx.insert(financialTransactions).values({
      accountId: poolAccount.id,
      direction: "DEBIT",
      amount: netAmount,
      balanceBefore: poolBalance,
      balanceAfter: poolAfterWinner,
      referenceType: "payout",
      referenceId: payout.id,
      description: `Transfer payout ke wallet pemenang ${winnerParticipant.userId}`,
      idempotencyKey: `${payoutKey}-POOL-DEBIT-WINNER`,
    });

    await tx.execute(sql`SELECT id FROM wallets WHERE user_id = ${winnerParticipant.userId} FOR UPDATE`);
    const [winnerWallet] = await tx.select().from(wallets).where(eq(wallets.userId, winnerParticipant.userId)).limit(1);
    if (!winnerWallet) throw new ApiError("Wallet pemenang tidak ditemukan.", "WALLET_NOT_FOUND", 500);
    const winnerAvailableAfter = winnerWallet.availableBalance + netAmount;
    await tx.update(wallets).set({ availableBalance: winnerAvailableAfter, updatedAt: now }).where(eq(wallets.id, winnerWallet.id));
    await tx.insert(walletTransactions).values({
      walletId: winnerWallet.id,
      userId: winnerParticipant.userId,
      type: "PAYOUT",
      direction: "CREDIT",
      amount: netAmount,
      availableBefore: winnerWallet.availableBalance,
      availableAfter: winnerAvailableAfter,
      lockedBefore: winnerWallet.lockedBalance,
      lockedAfter: winnerWallet.lockedBalance,
      pendingBefore: winnerWallet.pendingBalance,
      pendingAfter: winnerWallet.pendingBalance,
      referenceType: "payout",
      referenceId: payout.id,
      description: `Payout bersih dari settlement pool ${period.code}`,
      idempotencyKey: `${payoutKey}-CREDIT-WINNER`,
    });

    // Phase 9: transfer the platform fee from the pool to the platform fee account.
    const poolAfterFee = poolAfterWinner - feeAmount;
    if (poolAfterFee < 0) throw new ApiError("Saldo settlement pool tidak cukup untuk fee.", "SETTLEMENT_POOL_FEE_MISMATCH", 500);
    if (feeAmount > 0) {
      await tx.update(financialAccounts).set({ balance: poolAfterFee, updatedAt: now }).where(eq(financialAccounts.id, poolAccount.id));
      await tx.insert(financialTransactions).values({
        accountId: poolAccount.id,
        direction: "DEBIT",
        amount: feeAmount,
        balanceBefore: poolAfterWinner,
        balanceAfter: poolAfterFee,
        referenceType: "platform_fee",
        referenceId: payout.id,
        description: `Transfer fee platform dari settlement ${period.code}`,
        idempotencyKey: `${payoutKey}-POOL-DEBIT-FEE`,
      });

      const feeAfter = feeAccount.balance + feeAmount;
      await tx.update(financialAccounts).set({ balance: feeAfter, updatedAt: now }).where(eq(financialAccounts.id, feeAccount.id));
      await tx.insert(financialTransactions).values({
        accountId: feeAccount.id,
        direction: "CREDIT",
        amount: feeAmount,
        balanceBefore: feeAccount.balance,
        balanceAfter: feeAfter,
        referenceType: "platform_fee",
        referenceId: payout.id,
        description: `Fee platform periode ${period.code}`,
        idempotencyKey: `${payoutKey}-FEE-CREDIT`,
      });
      await tx.insert(platformFees).values({ periodId: period.id, amount: feeAmount, payoutId: payout.id });
    }

    // Phase 10: final accounting invariant.
    if (poolAfterFee !== 0) throw new ApiError("Settlement pool belum kembali ke nol.", "SETTLEMENT_POOL_NOT_ZERO", 500);

    const completedParticipantIds = active.filter((participant) => participant.id !== winnerParticipant.id).map((participant) => participant.id);
    if (completedParticipantIds.length) {
      await tx.update(arisanParticipants).set({ status: "COMPLETED", updatedAt: now }).where(inArray(arisanParticipants.id, completedParticipantIds));
    }
    await tx.insert(notifications).values(active.map((participant) => ({
        userId: participant.userId,
        title: participant.userId === winnerParticipant.userId ? "Selamat, Anda terpilih!" : "Drawing selesai",
        message:
          participant.userId === winnerParticipant.userId
            ? `Anda memenangkan ${formatRupiah(netAmount)}. Dana telah ditambahkan ke saldo tersedia.`
            : `Drawing ${period.code} telah selesai. Pemenang: ${winner?.name ?? "Peserta terpilih"}.`,
        type: participant.userId === winnerParticipant.userId ? "ARISAN_WINNER" : "ARISAN_DRAW_COMPLETED",
        referenceType: "arisan_period",
        referenceId: period.id,
      })));

    await tx.insert(payoutAttempts).values({
      payoutId: payout.id, attemptNumber: 1, fromStatus: "PROCESSING", toStatus: "SUCCESS",
      idempotencyKey: `${payoutKey}-ATTEMPT-1-SUCCESS`,
    });
    await tx.update(payouts).set({ status: "SUCCESS", processedAt: now, updatedAt: now }).where(eq(payouts.id, payout.id));
    await tx.update(arisanPeriods).set({ status: "COMPLETED", updatedAt: now }).where(eq(arisanPeriods.id, period.id));
    if (input.actorType !== "SYSTEM") await tx.update(drawAuthorizations).set({ status: "EXECUTED", executedAt: now, updatedAt: now }).where(eq(drawAuthorizations.periodId, period.id));
    await tx.insert(auditLogs).values({
      actorId: input.actorId ?? null,
      actorType: input.actorType,
      action: "ARISAN_DRAW_AND_PAYOUT_SETTLED",
      entityType: "arisan_period",
      entityId: period.id,
      newValue: {
        drawingId: drawing.id,
        winnerId: winnerParticipant.userId,
        eligibleCount: active.length,
        grossAmount,
        feeAmount,
        payoutAmount: netAmount,
        settlementAccountId: poolAccount.id,
        platformFeeAccountId: feeAccount.id,
        settlementPoolFinalBalance: poolAfterFee,
      },
      ipAddress: input.meta?.ipAddress ?? null,
      userAgent: input.meta?.userAgent ?? null,
    });

    return {
      status: "COMPLETED" as const,
      winnerId: winnerParticipant.userId,
      winnerName: winner?.name ?? "Pemenang",
      grossAmount,
      feeAmount,
      payoutAmount: netAmount,
      participantCount: active.length,
      randomReference,
      settlementAccountId: poolAccount.id,
    };
  });
}

function formatRupiah(amount: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(amount);
}
