import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, userSessions } from "@/db/schema";
import { clearAuthCookies, hashToken, readCookie, verifyAccessToken } from "@/server/auth";
import { assertSameOrigin, errorResponse, getRequestMetadata, jsonOk } from "@/server/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const accessClaims = readCookie(request, "access_token");
    const claims = accessClaims ? verifyAccessToken(accessClaims) : null;
    const refresh = readCookie(request, "refresh_token");
    const metadata = getRequestMetadata(request);
    await db.transaction(async (tx) => {
      const revoked = refresh
        ? await tx
            .update(userSessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(userSessions.refreshTokenHash, hashToken(refresh)), isNull(userSessions.revokedAt)))
            .returning({ id: userSessions.id, userId: userSessions.userId })
        : claims
          ? await tx
              .update(userSessions)
              .set({ revokedAt: new Date() })
              .where(and(eq(userSessions.id, claims.sid), isNull(userSessions.revokedAt)))
              .returning({ id: userSessions.id, userId: userSessions.userId })
          : [];
      if (revoked[0]) {
        await tx.insert(auditLogs).values({
          actorId: revoked[0].userId,
          actorType: "USER",
          action: "USER_LOGOUT",
          entityType: "user_session",
          entityId: revoked[0].id,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
        });
      }
    });
    const response = jsonOk({ loggedOut: true }, "Anda telah keluar.");
    for (const cookie of clearAuthCookies()) response.headers.append("set-cookie", cookie);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
