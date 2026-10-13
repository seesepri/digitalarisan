import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requiredString } from "@/server/http";
import { normalizePhoneNumber } from "@/server/phone";
import { resetPasswordWithPhoneCode } from "@/server/services/phone-verification";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "password-reset-complete-ip", 10, 15 * 60_000);
    const body = await readJson(request);
    const phone = normalizePhoneNumber(body.phone);
    const code = requiredString(body.code, "Kode OTP", 4, 10);
    if (!/^\d{4,10}$/.test(code)) throw new ApiError("Format kode OTP tidak valid.", "VALIDATION_ERROR", 400);
    const newPassword = requiredString(body.newPassword, "Password baru", 10, 128);
    if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      throw new ApiError("Password harus memiliki minimal satu huruf dan satu angka.", "WEAK_PASSWORD", 400);
    }
    await enforceRateLimit(request, "password-reset-complete-phone", 6, 15 * 60_000, phone);
    await resetPasswordWithPhoneCode({ phone, code, newPassword, meta: getRequestMetadata(request) });
    return jsonOk({ reset: true }, "Password berhasil direset. Silakan masuk menggunakan password baru.");
  } catch (error) {
    return errorResponse(error);
  }
}
