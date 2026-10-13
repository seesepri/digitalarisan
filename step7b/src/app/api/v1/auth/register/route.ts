import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, jsonOk, readJson } from "@/server/http";
import { normalizePhoneNumber } from "@/server/phone";
import { startPhoneVerification } from "@/server/services/phone-verification";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "auth-register-ip", 6, 60_000);
    const body = await readJson(request);
    const phone = normalizePhoneNumber(body.phone);
    await enforceRateLimit(request, "phone-otp-send-ip", 10, 60 * 60_000);
    await enforceRateLimit(request, "auth-register-phone", 3, 60 * 60_000, phone);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1);
    if (existing) throw new ApiError("Nomor HP sudah terdaftar. Silakan masuk menggunakan nomor tersebut.", "ACCOUNT_EXISTS", 409);

    const result = await startPhoneVerification({ phone, purpose: "SIGNUP" });
    return jsonOk({ verificationRequired: true, phone, expiresInSeconds: result.expiresInSeconds }, "Kode OTP dikirim melalui SMS. Verifikasi nomor HP untuk mengaktifkan akun.", 202);
  } catch (error) {
    return errorResponse(error);
  }
}
