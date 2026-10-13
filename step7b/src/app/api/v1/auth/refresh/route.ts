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
      // Lock the user before a session so rotation and reuse revocation cannot pass each other.
      const [candidate] = await tx.select({ userId: userSessions.userId }).from(userSessions).where(eq(userSessions.refreshTokenHash, oldHash)).limit(1);
      if (!candidate) throw new ApiError("Sesi refresh tidak valid atau telah berakhir.", "INVALID_SESSION", 401);
      await tx.execute(sql`SELECT id FROM users WHERE id = ${candidate.userId} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM user_sessions WHERE refresh_token_hash = ${oldHash} FOR UPDATE`);
      const [record] = await tx
        .select({
          sessionId: userSessions.id,
          familyId: userSessions.familyId,
          revocationReason: userSessions.revocationReason,
          rotatedToSessionId: userSessions.rotatedToSessionId,
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
        // A short collision window ONLY rejects the loser (409); it never authenticates an old token.
        // A verified active successor distinguishes rotation from logout/reset revocation.
        if (record.revocationReason === "ROTATED" && record.rotatedToSessionId && Date.now() - record.revokedAt.getTime() <= 5_000) {
          const [successor] = await tx.select({ id: userSessions.id }).from(userSessions).where(and(eq(userSessions.id, record.rotatedToSessionId), eq(userSessions.familyId, record.familyId), isNull(userSessions.revokedAt))).limit(1);
          if (successor && record.userStatus === "ACTIVE" && record.phoneVerifiedAt) {
            await tx.insert(auditLogs).values({ actorId: record.userId, actorType: "SYSTEM", action: "REFRESH_ROTATION_COLLISION", entityType: "user_session", entityId: record.sessionId });
            return { reuseDetected: false as const, collision: true as const };
          }
        }
        // Legacy sessions lack family provenance: keep the previous conservative global revoke.
        const familyScope = record.revocationReason === null ? eq(userSessions.userId, record.userId) : and(eq(userSessions.userId, record.userId), eq(userSessions.familyId, record.familyId));
        await tx.update(userSessions).set({ revokedAt: new Date(), revocationReason: "REUSE" }).where(and(familyScope, isNull(userSessions.revokedAt)));
        await tx.insert(auditLogs).values({ actorId: record.userId, actorType: "SYSTEM", action: "REFRESH_TOKEN_REUSE_DETECTED", entityType: "user_session", entityId: record.sessionId, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent });
        return { reuseDetected: true as const };
      }
      if (record.expiresAt <= new Date() || record.userStatus !== "ACTIVE" || !record.phoneVerifiedAt) {
        throw new ApiError("Sesi refresh tidak valid atau telah berakhir.", "INVALID_SESSION", 401);
      }
      const newRefreshToken = createRefreshToken();
      const [newSession] = await tx
        .insert(userSessions)
        .values({
          userId: record.userId,
          familyId: record.familyId,
          refreshTokenHash: hashToken(newRefreshToken),
          expiresAt: new Date(Date.now() + refreshTokenMaxAge * 1000),
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
        })
        .returning({ id: userSessions.id });
      await tx.update(userSessions).set({ revokedAt: new Date(), revocationReason: "ROTATED", rotatedToSessionId: newSession.id }).where(eq(userSessions.id, record.sessionId));
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
        collision: false as const,
        user: { id: record.userId, name: record.name, email: record.email, phone: record.phone, role: record.role },
        sessionId: newSession.id,
        refreshToken: newRefreshToken,
      };
    });

    if (rotated.reuseDetected) {
      throw new ApiError("Sesi refresh tidak valid atau telah digunakan kembali.", "REFRESH_TOKEN_REUSE_DETECTED", 401);
    }

    if (rotated.collision) throw new ApiError("Sesi sudah diperbarui oleh permintaan lain; gunakan cookie terbaru.", "REFRESH_ROTATION_COLLISION", 409);

    const response = jsonOk({ user: rotated.user }, "Sesi diperbarui.");
    response.headers.append("set-cookie", cookieHeader("access_token", createAccessToken(rotated.user.id, rotated.sessionId), accessTokenMaxAge));
    response.headers.append("set-cookie", cookieHeader("refresh_token", rotated.refreshToken, refreshTokenMaxAge));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
