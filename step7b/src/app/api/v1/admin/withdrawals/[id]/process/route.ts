import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requireAdmin, requiredString } from "@/server/http";
import { processWithdrawal } from "@/server/services/payout-withdrawal";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "admin-financial-withdrawal-process", 20, 60_000);
    const admin = await requireAdmin(request);
    const { id } = await context.params;
    const body = await readJson(request);
    const decision = requiredString(body.status, "Status", 6, 20);
    // Terminal states are provider-authoritative and must be reached through /execute.
    // This endpoint only performs the local PENDING/FAILED_RETRYABLE -> PROCESSING transition.
    if (decision !== "PROCESSING") {
      throw new ApiError("SUCCESS/FAILED hanya dapat ditetapkan berdasarkan status payout provider melalui endpoint execute.", "WITHDRAWAL_PROVIDER_CONFIRMATION_REQUIRED", 409);
    }
    const result = await processWithdrawal({
      withdrawalId: id,
      decision: "PROCESSING",
      adminId: admin.id,
      adminRole: admin.role,
      meta: getRequestMetadata(request),
    });
    return jsonOk(result, result.replayed ? "Status withdrawal sudah tercatat." : `Withdrawal ditandai ${result.status}.`);
  } catch (error) {
    return errorResponse(error);
  }
}
