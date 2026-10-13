import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requireAdmin, requiredString } from "@/server/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const admin = await requireAdmin(request);
    await enforceRateLimit(request, "admin-kyc-review", 30, 60_000, admin.id);
    const { id } = await context.params;
    const body = await readJson(request);
    const status = requiredString(body.status, "Status KYC", 7, 10);
    if (!["IN_REVIEW", "VERIFIED", "REJECTED"].includes(status)) throw new ApiError("Status KYC tidak valid.", "VALIDATION_ERROR", 400);
    if (status === "VERIFIED" && id === admin.id) throw new ApiError("Administrator tidak dapat memverifikasi KYC akunnya sendiri.", "KYC_SELF_APPROVAL_BLOCKED", 403);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
    if (status === "REJECTED" && !reason) throw new ApiError("Alasan penolakan KYC wajib diisi.", "VALIDATION_ERROR", 400);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${id} FOR UPDATE`);
      const [user] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
      if (!user) throw new ApiError("Pengguna tidak ditemukan.", "USER_NOT_FOUND", 404);
      const now = new Date();
      const [updated] = await tx.update(users).set({ kycStatus: status as "IN_REVIEW" | "VERIFIED" | "REJECTED", kycReviewedAt: now, kycReviewedBy: admin.id, kycVerifiedAt: status === "VERIFIED" ? now : null, kycRejectionReason: status === "REJECTED" ? reason : null, updatedAt: now }).where(eq(users.id, id)).returning({ id: users.id, kycStatus: users.kycStatus, kycVerifiedAt: users.kycVerifiedAt });
      await tx.insert(auditLogs).values({ actorId: admin.id, actorType: admin.role, action: `KYC_${status}`, entityType: "user", entityId: user.id, oldValue: { kycStatus: user.kycStatus }, newValue: { kycStatus: status }, ipAddress: getRequestMetadata(request).ipAddress, userAgent: getRequestMetadata(request).userAgent });
      return updated;
    });
    return jsonOk(result, "Status KYC diperbarui.");
  } catch (error) {
    return errorResponse(error);
  }
}
