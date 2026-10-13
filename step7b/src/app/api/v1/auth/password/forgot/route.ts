import { assertSameOrigin, enforceRateLimit, errorResponse, jsonOk, readJson } from "@/server/http";
import { normalizePhoneNumber } from "@/server/phone";
import { startPasswordReset } from "@/server/services/phone-verification";

const GENERIC_MESSAGE = "Jika nomor HP terdaftar dan terverifikasi, kode reset akan dikirim melalui SMS.";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "password-reset-request-ip", 10, 60 * 60_000);
    const body = await readJson(request);
    const phone = normalizePhoneNumber(body.phone);
    await enforceRateLimit(request, "password-reset-request-phone", 3, 60 * 60_000, phone);
    await startPasswordReset(phone);
    return jsonOk({ requested: true }, GENERIC_MESSAGE, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
