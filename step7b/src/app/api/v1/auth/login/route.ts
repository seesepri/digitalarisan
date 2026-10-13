import { eq, or } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, userSessions, users } from "@/db/schema";
import { accessTokenMaxAge, cookieHeader, createAccessToken, createRefreshToken, hashToken, refreshTokenMaxAge, verifyPassword } from "@/server/auth";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requiredString } from "@/server/http";
import { startPhoneVerification } from "@/server/services/phone-verification";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "auth-login-ip", 8, 60_000);
    const body = await readJson(request);
    const identifier = requiredString(body.identifier, "Email atau nomor HP", 3, 255).toLowerCase();
    const password = requiredString(body.password, "Password", 1, 128);
    await enforceRateLimit(request, "auth-login-identifier", 6, 10 * 60_000, identifier);
    const normalizedPhone = identifier.replace(/[\s()-]/g, "");
    const [user] = await db
      .select()
      .from(users)
      .where(or(eq(users.email, identifier), eq(users.phone, normalizedPhone)))
      .limit(1);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new ApiError("Email/nomor HP atau password tidak sesuai.", "INVALID_CREDENTIALS", 401);
    }
    if (user.status !== "ACTIVE") throw new ApiError("Akun sedang tidak aktif. Hubungi dukungan.", "ACCOUNT_INACTIVE", 403);
    if (!user.phoneVerifiedAt) {
      await enforceRateLimit(request, "phone-otp-send-ip", 10, 60 * 60_000);
      await enforceRateLimit(request, "auth-login-phone-verification", 3, 60 * 60_000, user.phone);
      const result = await startPhoneVerification({ phone: user.phone, userId: user.id, purpose: "LOGIN_VERIFY" });
      return jsonOk({ verificationRequired: true, phone: user.phone, expiresInSeconds: result.expiresInSeconds }, "Verifikasi nomor HP diperlukan sebelum masuk. Kode OTP dikirim melalui SMS.", 202);
    }

    const refreshToken = createRefreshToken();
    const metadata = getRequestMetadata(request);
    const [session] = await db
      .insert(userSessions)
      .values({
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshTokenMaxAge * 1000),
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
      })
      .returning({ id: userSessions.id });
    await db.insert(auditLogs).values({
      actorId: user.id,
      actorType: "USER",
      action: "USER_LOGIN",
      entityType: "user_session",
      entityId: session.id,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    });

    const response = jsonOk(
      { user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } },
      "Berhasil masuk.",
    );
    response.headers.append("set-cookie", cookieHeader("access_token", createAccessToken(user.id, session.id), accessTokenMaxAge));
    response.headers.append("set-cookie", cookieHeader("refresh_token", refreshToken, refreshTokenMaxAge));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
