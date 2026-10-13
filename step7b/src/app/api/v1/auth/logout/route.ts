import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users, userSessions } from "@/db/schema";
import { clearAuthCookies, hashToken, readCookie, verifyAccessToken } from "@/server/auth";
import { assertSameOrigin, errorResponse, getRequestMetadata, jsonOk } from "@/server/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const access = readCookie(request, "access_token"); const claims = access ? verifyAccessToken(access) : null;
    const refresh = readCookie(request, "refresh_token"); const metadata = getRequestMetadata(request);
    await db.transaction(async (tx) => {
      const condition = refresh ? eq(userSessions.refreshTokenHash, hashToken(refresh)) : claims ? and(eq(userSessions.id, claims.sid), eq(userSessions.userId, claims.sub)) : null;
      if (!condition) return;
      const [session] = await tx.select().from(userSessions).where(condition).limit(1);
      if (!session) return;
      // Same user-first lock order as refresh, so an in-flight rotation cannot survive logout.
      await tx.execute(sql`SELECT id FROM ${users} WHERE id=${session.userId} FOR UPDATE`);
      const revoked = await tx.update(userSessions).set({ revokedAt: new Date(), revocationReason: "LOGOUT" }).where(and(eq(userSessions.userId, session.userId), eq(userSessions.familyId, session.familyId), isNull(userSessions.revokedAt))).returning({ id: userSessions.id });
      if (revoked.length) await tx.insert(auditLogs).values({ actorId: session.userId, actorType: "USER", action: "USER_LOGOUT", entityType: "user_session", entityId: session.id, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent });
    });
    const response = jsonOk({ loggedOut: true }, "Anda telah keluar.");
    for (const cookie of clearAuthCookies()) response.headers.append("set-cookie", cookie);
    return response;
  } catch (error) { return errorResponse(error); }
}
