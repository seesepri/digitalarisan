import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getIdempotencyKey, getRequestMetadata, jsonOk, positiveInteger, readJson, requireUser, requiredString } from "@/server/http";
import { createWithdrawal } from "@/server/services/wallet";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "wallet-withdrawal", 5, 60_000);
    const user = await requireUser(request);
    const body = await readJson(request);
    const amount = positiveInteger(body.amount, "Nominal withdrawal", 50_000_000);
    if (amount < 10_000) throw new ApiError("Nominal minimum withdrawal adalah Rp10.000.", "VALIDATION_ERROR", 400);
    const bankName = requiredString(body.bankName, "Nama bank", 2, 100);
    const accountName = requiredString(body.accountName, "Nama pemilik rekening", 2, 120);
    const accountNumber = requiredString(body.accountNumber, "Nomor rekening", 6, 32).replace(/[\s-]/g, "");
    if (!/^\d{6,32}$/.test(accountNumber)) throw new ApiError("Nomor rekening tidak valid.", "VALIDATION_ERROR", 400);
    const idempotencyKey = getIdempotencyKey(request, body);
    const result = await createWithdrawal({
      userId: user.id,
      amount,
      bankName,
      accountName,
      accountNumber,
      idempotencyKey,
      meta: getRequestMetadata(request),
    });
    return jsonOk({ withdrawal: result.withdrawal, replayed: result.replayed }, "Permintaan withdrawal tercatat dan menunggu proses.", result.replayed ? 200 : 201);
  } catch (error) {
    return errorResponse(error);
  }
}
