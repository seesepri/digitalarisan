import { accessTokenMaxAge, cookieHeader, createAccessToken, refreshTokenMaxAge } from "@/server/auth";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requiredString } from "@/server/http";
import { normalizePhoneNumber } from "@/server/phone";
import { verifyPhoneAndCreateSession } from "@/server/services/phone-verification";

type VerifiedSession = Awaited<ReturnType<typeof verifyPhoneAndCreateSession>>;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "phone-verification-ip", 12, 10 * 60_000);
    const body = await readJson(request);
    const phone = normalizePhoneNumber(body.phone);
    const code = requiredString(body.code, "Kode OTP", 4, 10);
    if (!/^\d{4,10}$/.test(code)) throw new ApiError("Format kode OTP tidak valid.", "VALIDATION_ERROR", 400);
    await enforceRateLimit(request, "phone-verification-number", 8, 10 * 60_000, phone);

    let registration: { name: string; password: string } | undefined;
    if (body.name !== undefined || body.password !== undefined) {
      const name = requiredString(body.name, "Nama", 2, 120);
      const password = requiredString(body.password, "Password", 10, 128);
      if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        throw new ApiError("Password harus memiliki minimal satu huruf dan satu angka.", "WEAK_PASSWORD", 400);
      }
      registration = { name, password };
    }
    const purpose = registration ? "SIGNUP" : "LOGIN_VERIFY";
    const session: VerifiedSession = await verifyPhoneAndCreateSession({ phone, code, purpose, registration, meta: getRequestMetadata(request) });
    const response = jsonOk({ user: session.user }, "Nomor HP berhasil diverifikasi. Akun aktif.");
    response.headers.append("set-cookie", cookieHeader("access_token", createAccessToken(session.user.id, session.sessionId), accessTokenMaxAge));
    response.headers.append("set-cookie", cookieHeader("refresh_token", session.refreshToken, refreshTokenMaxAge));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
