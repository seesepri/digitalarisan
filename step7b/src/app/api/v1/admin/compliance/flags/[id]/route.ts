import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, complianceFlags, withdrawals } from "@/db/schema";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requireAdmin, requiredString } from "@/server/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "admin-financial-compliance", 20, 60_000);
    const admin = await requireAdmin(request);
    const { id } = await context.params;
    const body = await readJson(request);
    const decision = requiredString(body.status, "Status", 7, 10);
    if (decision !== "RESOLVED" && decision !== "DISMISSED") throw new ApiError("Status harus RESOLVED atau DISMISSED.", "VALIDATION_ERROR", 400);
    const reason = requiredString(body.reason, "Alasan", 5, 500);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM compliance_flags WHERE id = ${id} FOR UPDATE`);
      const [flag] = await tx.select().from(complianceFlags).where(eq(complianceFlags.id, id)).limit(1);
      if (!flag) throw new ApiError("Compliance flag tidak ditemukan.", "COMPLIANCE_FLAG_NOT_FOUND", 404);
      if (flag.status !== "OPEN") return { flag, replayed: true };
      let withdrawalRiskStatus: string | null = null;
      if (flag.withdrawalId) {
        await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${flag.withdrawalId} FOR UPDATE`);
        const [withdrawal] = await tx.select({ riskStatus: withdrawals.riskStatus }).from(withdrawals).where(eq(withdrawals.id, flag.withdrawalId)).limit(1);
        withdrawalRiskStatus = withdrawal?.riskStatus ?? null;
      }
      const highRiskOverride = ["HIGH", "CRITICAL"].includes(flag.severity.toUpperCase()) || flag.score >= 100 || withdrawalRiskStatus === "BLOCKED";
      if (highRiskOverride && admin.role !== "SUPER_ADMIN") {
        throw new ApiError("Flag compliance berisiko tinggi hanya dapat diselesaikan oleh SUPER_ADMIN.", "HIGH_RISK_COMPLIANCE_OVERRIDE_REQUIRED", 403);
      }
      const [updated] = await tx.update(complianceFlags).set({ status: decision, resolvedBy: admin.id, resolvedAt: new Date(), reason: `${flag.reason} | Review: ${reason}` }).where(eq(complianceFlags.id, id)).returning();
      await tx.insert(auditLogs).values({ actorId: admin.id, actorType: admin.role, action: `COMPLIANCE_FLAG_${decision}`, entityType: "compliance_flag", entityId: flag.id, oldValue: { status: flag.status }, newValue: { status: decision, ruleCode: flag.ruleCode }, ipAddress: getRequestMetadata(request).ipAddress, userAgent: getRequestMetadata(request).userAgent });
      if (flag.withdrawalId) {
        const [open] = await tx.select({ count: sql<number>`count(*)` }).from(complianceFlags).where(and(eq(complianceFlags.withdrawalId, flag.withdrawalId), eq(complianceFlags.status, "OPEN")));
        if (Number(open?.count ?? 0) === 0) {
          await tx.update(withdrawals).set({ riskStatus: "CLEAR", updatedAt: new Date() }).where(eq(withdrawals.id, flag.withdrawalId));
        }
      }
      return { flag: updated, replayed: false };
    });
    return jsonOk(result, result.replayed ? "Compliance flag sudah diproses." : "Compliance flag diproses.");
  } catch (error) {
    return errorResponse(error);
  }
}
