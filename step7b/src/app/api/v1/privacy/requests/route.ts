import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { privacyRequests, users } from "@/db/schema";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, jsonOk, readJson, requireUser } from "@/server/http";

export async function GET(request: Request) {
  try { const user = await requireUser(request); const rows = await db.select().from(privacyRequests).where(eq(privacyRequests.userId, user.id)).orderBy(desc(privacyRequests.createdAt)).limit(50); return jsonOk({ requests: rows }); } catch (e) { return errorResponse(e); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    await enforceRateLimit(request, "privacy-request", 5, 60 * 60_000, user.id);
    const body = await readJson(request);
    const type = body.type === "EXPORT" || body.type === "ERASURE" ? body.type : null;
    if (!type) throw new ApiError("type harus EXPORT atau ERASURE", "INVALID_PRIVACY_REQUEST", 400);
    const [row] = await db.transaction(async (tx) => {
      // Serialize active-request checks per user so simultaneous submissions cannot both pass.
      await tx.execute(sql`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`);
      const [existing] = await tx.select({ id: privacyRequests.id }).from(privacyRequests).where(and(eq(privacyRequests.userId, user.id), inArray(privacyRequests.status, ["PENDING", "IN_PROGRESS"]))).limit(1);
      if (existing) throw new ApiError("Permintaan privasi aktif sudah ada.", "PRIVACY_REQUEST_EXISTS", 409);
      return tx.insert(privacyRequests).values({ userId: user.id, type, reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null }).returning();
    });
    return jsonOk(row, "Permintaan privasi dibuat.", 201);
  } catch (e) { return errorResponse(e); }
}
