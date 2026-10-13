import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getIdempotencyKey, getRequestMetadata, jsonOk, positiveInteger, readJson, requireUser } from "@/server/http";
import { createTopup } from "@/server/services/wallet";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "wallet-topup", 8, 60_000);
    const user = await requireUser(request);
    const body = await readJson(request);
    const amount = positiveInteger(body.amount, "Nominal top-up", 50_000_000);
    if (amount < 10_000) throw new ApiError("Nominal minimum top-up adalah Rp10.000.", "VALIDATION_ERROR", 400);
    const idempotencyKey = getIdempotencyKey(request, body);
    const callbackUrl = process.env.PAYMENT_RETURN_URL?.trim();
    if (!callbackUrl) throw new ApiError("PAYMENT_RETURN_URL belum dikonfigurasi.", "PAYMENT_PROVIDER_UNAVAILABLE", 503);
    try {
      const parsedCallbackUrl = new URL(callbackUrl);
      if (parsedCallbackUrl.protocol !== "https:" && process.env.NODE_ENV === "production") {
        throw new ApiError("PAYMENT_RETURN_URL production harus menggunakan HTTPS.", "PAYMENT_PROVIDER_CONFIG_INVALID", 500);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("PAYMENT_RETURN_URL tidak valid.", "PAYMENT_PROVIDER_CONFIG_INVALID", 500);
    }
    const result = await createTopup({ userId: user.id, amount, idempotencyKey, callbackUrl, meta: getRequestMetadata(request) });
    return jsonOk(
      {
        topup: {
          id: result.topup.id,
          amount: result.topup.amount,
          status: result.topup.status,
          provider: result.topup.provider,
          providerReference: result.topup.providerReference,
          checkoutUrl: result.topup.checkoutUrl,
          expiresAt: result.topup.expiresAt,
        },
        payment: { configured: Boolean(result.topup.checkoutUrl), checkoutUrl: result.topup.checkoutUrl },
        replayed: result.replayed,
      },
      result.replayed ? "Intent pembayaran sebelumnya dikembalikan." : "Instruksi pembayaran tersedia.",
      result.replayed ? 200 : 201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
