import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, userSessions, users } from "@/db/schema";
import { accessTokenMaxAge, cookieHeader, createAccessToken, createRefreshToken, hashToken, readCookie, refreshTokenMaxAge } from "@/server/auth";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk } from "@/server/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "auth-refresh", 20, 60_000);
    const refreshToken = readCookie(request, "refresh_token");
    if (!refreshToken) throw new ApiError("Sesi refresh tidak ditemukan.", "UNAUTHORIZED", 401);
    const oldHash = hashToken(refreshToken);
    const metadata = getRequestMetadata(request);

    const rotated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM user_sessions WHERE refresh_token_hash = ${oldHash} FOR UPDATE`);
      const [record] = await tx
        .select({
          sessionId: userSessions.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          phone: users.phone,
          role: users.role,
          userStatus: users.status,
          phoneVerifiedAt: users.phoneVerifiedAt,
          expiresAt: userSessions.expiresAt,
          revokedAt: userSessions.revokedAt,
        })
        .from(userSessions)
        .innerJoin(users, eq(userSessions.userId, users.id))
        .where(eq(userSessions.refreshTokenHash, oldHash))
        .limit(1);
      if (!record) {
        throw new ApiError("Sesi refresh tidak valid atau telah berakhir.", "INVALID_SESSION", 401);
      }
      if (record.revokedAt) {
        await tx.update(userSessions).set({ revokedAt: new Date() }).where(and(eq(userSessions.userId, record.userId), isNull(userSessions.revokedAt)));
        await tx.insert(auditLogs).values({ actorId: record.userId, actorType: "SYSTEM", action: "REFRESH_TOKEN_REUSE_DETECTED", entityType: "user_session", entityId: record.sessionId, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent });
        return { reuseDetected: true as const };
      }
      if (record.expiresAt <= new Date() || record.userStatus !== "ACTIVE" || !record.phoneVerifiedAt) {
        throw new ApiError("Sesi refresh tidak valid atau telah berakhir.", "INVALID_SESSION", 401);
      }
      await tx.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.id, record.sessionId));
      const newRefreshToken = createRefreshToken();
      const [newSession] = await tx
        .insert(userSessions)
        .values({
          userId: record.userId,
          refreshTokenHash: hashToken(newRefreshToken),
          expiresAt: new Date(Date.now() + refreshTokenMaxAge * 1000),
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
        })
        .returning({ id: userSessions.id });
      await tx.insert(auditLogs).values({
        actorId: record.userId,
        actorType: "USER",
        action: "SESSION_REFRESHED",
        entityType: "user_session",
        entityId: newSession.id,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
      });
      return {
        reuseDetected: false as const,
        user: { id: record.userId, name: record.name, email: record.email, phone: record.phone, role: record.role },
        sessionId: newSession.id,
        refreshToken: newRefreshToken,
      };
    });

    if (rotated.reuseDetected) {
      throw new ApiError("Sesi refresh tidak valid atau telah digunakan kembali.", "REFRESH_TOKEN_REUSE_DETECTED", 401);
    }

    const response = jsonOk({ user: rotated.user }, "Sesi diperbarui.");
    response.headers.append("set-cookie", cookieHeader("access_token", createAccessToken(rotated.user.id, rotated.sessionId), accessTokenMaxAge));
    response.headers.append("set-cookie", cookieHeader("refresh_token", rotated.refreshToken, refreshTokenMaxAge));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
