import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, privacyRequests, userSessions, users, withdrawals } from "@/db/schema";
import {
  assertSameOrigin,
  enforceRateLimit,
  errorResponse,
  jsonOk,
  readJson,
  requireAdmin,
} from "@/server/http";

const PRIVACY_REQUEST_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "COMPLETED",
  "REJECTED",
] as const;

type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

const isPrivacyRequestStatus = (
  value: unknown,
): value is PrivacyRequestStatus =>
  typeof value === "string" &&
  (PRIVACY_REQUEST_STATUSES as readonly string[]).includes(value);

const isAllowedTransition = (
  current: PrivacyRequestStatus,
  next: PrivacyRequestStatus,
): boolean => {
  if (current === "PENDING") {
    return next === "IN_PROGRESS";
  }

  if (current === "IN_PROGRESS") {
    return next === "COMPLETED" || next === "REJECTED";
  }

  return false;
};

export async function GET(request: Request) {
  try {
    await requireAdmin(request);

    const rows = await db
      .select()
      .from(privacyRequests)
      .where(
        inArray(privacyRequests.status, ["PENDING", "IN_PROGRESS"]),
      )
      .orderBy(asc(privacyRequests.createdAt))
      .limit(100);

    return jsonOk({ requests: rows });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);

    const admin = await requireAdmin(request);
    await enforceRateLimit(request, "admin-privacy-decision", 30, 60_000, admin.id);
    const body = await readJson(request);

    const id = typeof body.id === "string" ? body.id.trim() : "";
    const decision = body.decision;

    if (!id || !isPrivacyRequestStatus(decision)) {
      return Response.json(
        {
          success: false,
          message: "id dan decision wajib.",
          code: "INVALID_PRIVACY_DECISION",
        },
        { status: 400 },
      );
    }

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM privacy_requests WHERE id = ${id} FOR UPDATE`);
      const [requestRow] = await tx
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.id, id))
        .limit(1);

      if (!requestRow) {
        throw new Error("PRIVACY_REQUEST_NOT_FOUND");
      }

      const currentStatus = requestRow.status as PrivacyRequestStatus;

      if (!isAllowedTransition(currentStatus, decision)) {
        throw new Error("PRIVACY_REQUEST_INVALID_TRANSITION");
      }

      const now = new Date();

      /*
       * ERASURE is deliberately handled as an application-level
       * anonymization/revocation operation.
       *
       * Financial records retain their user FK because those records
       * are part of the financial/audit history and must not be
       * accidentally deleted by a user privacy request.
       */
      if (decision === "COMPLETED" && requestRow.type === "ERASURE") {
        await tx
          .update(userSessions)
          .set({ revokedAt: now })
          .where(eq(userSessions.userId, requestRow.userId));

        await tx
          .update(users)
          .set({
            name: `Deleted User ${requestRow.userId.slice(0, 8)}`,
            phone: `deleted-${requestRow.userId.slice(0, 8)}@invalid`,
            email: `deleted-${requestRow.userId.slice(0, 8)}@invalid`,
            avatarUrl: null,
            passwordHash: "ERASED",
            status: "SUSPENDED",
            phoneVerifiedAt: null,
            kycVerifiedAt: null,
            kycReviewedAt: null,
            kycReviewedBy: null,
            kycRejectionReason: null,
            updatedAt: now,
          })
          .where(eq(users.id, requestRow.userId));

        /*
         * Withdrawal rows are financial history and remain immutable as
         * records, but their direct bank-account PII is not required for
         * historical accounting evidence. Replace it in-place rather than
         * deleting the withdrawal or breaking its user FK.
         */
        await tx
          .update(withdrawals)
          .set({
            bankName: "[REDACTED]",
            accountName: "[REDACTED]",
            accountNumber: "[REDACTED]",
            updatedAt: now,
          })
          .where(eq(withdrawals.userId, requestRow.userId));
      }

      const [updated] = await tx
        .update(privacyRequests)
        .set({
          status: decision,
          processedBy: admin.id,
          processedAt: now,
          updatedAt: now,
        })
        .where(eq(privacyRequests.id, id))
        .returning();

      await tx.insert(auditLogs).values({
        actorId: admin.id,
        actorType: admin.role,
        action: `PRIVACY_REQUEST_${decision}`,
        entityType: "privacy_request",
        entityId: id,
        newValue: {
          type: requestRow.type,
          status: decision,
          userId: requestRow.userId,
        },
      });

      return updated;
    });

    return jsonOk(result, "Permintaan privasi diperbarui.");
  } catch (error) {
    return errorResponse(error);
  }
}