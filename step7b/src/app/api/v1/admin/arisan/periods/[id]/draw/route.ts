import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requireAdmin, requireSuperAdmin, requiredString } from "@/server/http";
import { approveDrawAuthorization, drawAndSettle, requestDrawAuthorization } from "@/server/services/arisan";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "admin-financial-draw", 10, 60_000);
    const { id } = await context.params;
    const body = await readJson(request);
    const action = body.action === "APPROVE_AND_EXECUTE" ? "APPROVE_AND_EXECUTE" : body.action === "REQUEST" ? "REQUEST" : "";
    if (!action) throw new ApiError("Action drawing harus REQUEST atau APPROVE_AND_EXECUTE.", "VALIDATION_ERROR", 400);
    const reason = requiredString(body.reason, "Alasan", 10, 500);
    const meta = getRequestMetadata(request);

    if (action === "REQUEST") {
      const admin = await requireAdmin(request);
      const result = await requestDrawAuthorization({ periodId: id, actorId: admin.id, actorRole: admin.role, reason, meta });
      return jsonOk(result, result.replayed ? "Permintaan drawing sudah tercatat." : "Permintaan drawing menunggu persetujuan checker.", result.replayed ? 200 : 201);
    }

    const checker = await requireSuperAdmin(request);
    const approval = await approveDrawAuthorization({ periodId: id, actorId: checker.id, actorRole: checker.role, reason, meta });
    if (approval.replayed && approval.authorization.status === "EXECUTED") return jsonOk(approval, "Otorisasi drawing sudah dieksekusi.");
    const result = await drawAndSettle({ periodId: id, actorId: checker.id, actorType: checker.role, meta });
    return jsonOk({ authorization: approval.authorization, result }, result.status === "CANCELLED" ? "Periode tidak memenuhi minimum peserta dan dana dikembalikan." : "Drawing dan payout berhasil diselesaikan.");
  } catch (error) {
    return errorResponse(error);
  }
}
