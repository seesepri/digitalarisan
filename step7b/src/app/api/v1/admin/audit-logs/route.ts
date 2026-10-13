import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { errorResponse, jsonOk, requireAdmin } from "@/server/http";
import { redactAuditValue } from "@/server/privacy";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const requested = Number(new URL(request.url).searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 100) : 50;
    const rows = await db
      .select({
        id: auditLogs.id,
        actorId: auditLogs.actorId,
        actorName: users.name,
        actorType: auditLogs.actorType,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        oldValue: auditLogs.oldValue,
        newValue: auditLogs.newValue,
        ipAddress: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorId, users.id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return jsonOk({ auditLogs: rows.map((row) => ({ ...row, oldValue: redactAuditValue(row.oldValue), newValue: redactAuditValue(row.newValue) })) });
  } catch (error) {
    return errorResponse(error);
  }
}
