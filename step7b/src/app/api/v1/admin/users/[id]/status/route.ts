import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, userSessions, users } from "@/db/schema";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requireAdmin, requiredString } from "@/server/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const admin = await requireAdmin(request);
    await enforceRateLimit(request, "admin-user-status", 30, 60_000, admin.id);
    const { id } = await context.params;
    const body = await readJson(request);
    const status = requiredString(body.status, "Status", 6, 10);
    if (status !== "ACTIVE" && status !== "SUSPENDED") throw new ApiError("Status hanya boleh ACTIVE atau SUSPENDED.", "VALIDATION_ERROR", 400);
    if (id === admin.id && status === "SUSPENDED") throw new ApiError("Anda tidak dapat menangguhkan akun sendiri.", "SELF_SUSPENSION_BLOCKED", 409);
    const metadata = getRequestMetadata(request);
    const result = await db.transaction(async (tx) => {
      const [target] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
      if (!target) throw new ApiError("User tidak ditemukan.", "USER_NOT_FOUND", 404);
      if (target.role === "SUPER_ADMIN" && admin.role !== "SUPER_ADMIN") {
        throw new ApiError("Hanya super-admin yang dapat mengelola akun super-admin.", "FORBIDDEN", 403);
      }
      const [updated] = await tx.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id, status: users.status });
      if (status === "SUSPENDED") {
        await tx.update(userSessions).set({ revokedAt: new Date() }).where(and(eq(userSessions.userId, id), isNull(userSessions.revokedAt)));
      }
      await tx.insert(auditLogs).values({
        actorId: admin.id,
        actorType: admin.role,
        action: status === "SUSPENDED" ? "USER_SUSPENDED" : "USER_ACTIVATED",
        entityType: "user",
        entityId: id,
        oldValue: { status: target.status },
        newValue: { status },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
      });
      return updated;
    });
    return jsonOk({ user: result }, `Status user menjadi ${status}.`);
  } catch (error) {
    return errorResponse(error);
  }
}
