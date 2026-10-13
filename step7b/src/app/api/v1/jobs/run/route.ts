import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { arisanParticipants, arisanPeriods, notifications, topups } from "@/db/schema";
import { enforceRateLimit, errorResponse, jsonOk, ApiError } from "@/server/http";
import { drawAndSettle } from "@/server/services/arisan";
import { reconcileTopupPayment } from "@/server/services/wallet";
import { acquireJobLease, completeJob, failJob, renewJobLease } from "@/server/services/job-lock";
import { log } from "@/server/services/observability";

const SCHEDULER_JOB_KEY = "ARISAN_SCHEDULER";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || !authorization.startsWith("Bearer ")) return false;
  const received = authorization.slice(7);
  const expectedHash = createHash("sha256").update(secret).digest();
  const receivedHash = createHash("sha256").update(received).digest();
  return timingSafeEqual(expectedHash, receivedHash) && received.length === secret.length;
}

function jakartaDateKey(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return Date.UTC(year, month - 1, day);
}

export async function POST(request: Request) {
  try {
    if ((process.env.JOB_WORKER_ENABLED ?? "true").trim().toLowerCase() !== "true") {
      throw new ApiError("Job worker tidak diaktifkan pada instance aplikasi ini.", "JOB_WORKER_DISABLED", 503);
    }
    await enforceRateLimit(request, "cron-run", 30, 60_000);
    if (!isAuthorized(request)) throw new ApiError("Otorisasi scheduler tidak valid.", "UNAUTHORIZED", 401);

    const lease = await acquireJobLease({ jobKey: SCHEDULER_JOB_KEY, leaseMs: 120_000, maxAttempts: 5 });
    if (!lease) {
      return jsonOk({ jobKey: SCHEDULER_JOB_KEY, skipped: true, reason: "JOB_LOCKED_OR_NOT_DUE" }, "Scheduler sedang berjalan atau retry belum jatuh tempo.");
    }

    const assertLease = async () => {
      const renewed = await renewJobLease(lease, 120_000);
      if (!renewed) throw new ApiError("Lease scheduler hilang; eksekusi dihentikan untuk mencegah dua worker berjalan bersamaan.", "JOB_LEASE_LOST", 409);
    };

    try {
      const now = new Date();
      await assertLease();
      const statuses = ["OPEN", "FULL"] as const;
      const endedRegistration = await db
        .update(arisanPeriods)
        .set({ status: "LOCKED", updatedAt: now })
        .where(and(inArray(arisanPeriods.status, statuses), lte(arisanPeriods.registrationEndsAt, now)))
        .returning({ id: arisanPeriods.id });

      await assertLease();
      const upcoming = await db
        .select({
          id: arisanPeriods.id,
          code: arisanPeriods.code,
          drawingAt: arisanPeriods.drawingAt,
          participantCount: sql<number>`(select count(*)::int from arisan_participants p where p.period_id = ${arisanPeriods.id} and p.status = 'ACTIVE')`,
        })
        .from(arisanPeriods)
        .where(and(inArray(arisanPeriods.status, ["OPEN", "FULL", "LOCKED"]), sql`${arisanPeriods.drawingAt} > ${now}`))
        .limit(500);
      let remindersCreated = 0;
      let reminderCounter = 0;
      for (const period of upcoming) {
        const daysRemaining = Math.round((jakartaDateKey(period.drawingAt) - jakartaDateKey(now)) / 86_400_000);
        if (![1, 2, 3].includes(daysRemaining) || period.participantCount === 0) continue;
        const type = `ARISAN_REMINDER_H${daysRemaining}`;
        const title = daysRemaining === 2 ? "Hari terakhir pembatalan" : `Drawing dalam ${daysRemaining} hari`;
        const message =
          daysRemaining === 2
            ? `Hari ini adalah batas terakhir pembatalan untuk ${period.code}. Batas berlaku sampai pukul 23.59 WIB.`
            : `Pemilihan pemenang ${period.code} akan berlangsung ${daysRemaining} hari lagi.`;
        const participants = await db
          .select({ userId: arisanParticipants.userId })
          .from(arisanParticipants)
          .where(and(eq(arisanParticipants.periodId, period.id), eq(arisanParticipants.status, "ACTIVE")));
        if (participants.length) {
          const inserted = await db
            .insert(notifications)
            .values(participants.map((participant) => ({
              userId: participant.userId,
              title,
              message,
              type,
              referenceType: "arisan_period",
              referenceId: period.id,
            })))
            .onConflictDoNothing()
            .returning({ id: notifications.id });
          remindersCreated += inserted.length;
        }
        reminderCounter += participants.length;
        if (reminderCounter >= 50) { await assertLease(); reminderCounter = 0; }
      }

      await assertLease();
      let topupsReconciled = 0;
      const staleTopups = await db.select({ id: topups.id }).from(topups).where(and(inArray(topups.status, ["PENDING", "PROCESSING"]), sql`${topups.updatedAt} <= ${new Date(now.getTime() - 2 * 60_000)}`)).limit(50);
      for (const topup of staleTopups) {
        await assertLease();
        try { await reconcileTopupPayment({ topupId: topup.id }); topupsReconciled += 1; } catch (error) { log("ERROR", "topup_reconciliation_failed", { topupId: topup.id, error }); }
      }

      await assertLease();
      const duePeriods = await db
        .select({ id: arisanPeriods.id })
        .from(arisanPeriods)
        .where(and(inArray(arisanPeriods.status, ["OPEN", "FULL", "LOCKED"]), lte(arisanPeriods.drawingAt, now)))
        .limit(100);
      const drawingsProcessed: Array<{ periodId: string; status: string }> = [];
      for (const period of duePeriods) {
        await assertLease();
        try {
          const result = await drawAndSettle({ periodId: period.id, actorType: "SYSTEM" });
          drawingsProcessed.push({ periodId: period.id, status: result.status });
        } catch (error) {
          if (error instanceof ApiError && error.code === "DRAWING_ALREADY_EXECUTED") continue;
          throw error;
        }
      }

      await completeJob(lease);
      return jsonOk({
        jobKey: SCHEDULER_JOB_KEY,
        attemptCount: lease.attemptCount,
        registrationPeriodsLocked: endedRegistration.length,
        remindersCreated,
        topupsReconciled,
        drawingsProcessed,
        checkedAt: now.toISOString(),
      }, "Scheduler berhasil dijalankan.");
    } catch (error) {
      const errorCode = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
      const errorMessage = error instanceof Error ? error.message : "Unknown scheduler error";
      try {
        const retry = await failJob(lease, { errorCode, errorMessage });
        if (retry.retryable) {
          log("ERROR", "scheduler_job_failed_retry_scheduled", { errorCode, nextRunAt: retry.nextRunAt?.toISOString(), attemptCount: lease.attemptCount });
        } else {
          log("ERROR", "scheduler_job_failed_final", { errorCode, attemptCount: lease.attemptCount });
        }
      } catch (jobStateError) {
        log("ERROR", "scheduler_job_failure_state_persist_failed", { error: jobStateError });
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
