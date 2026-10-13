import { ApiError, assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, requireAdmin } from "@/server/http";
import { processWithdrawal } from "@/server/services/payout-withdrawal";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "admin-financial-withdrawal-retry", 10, 60_000);
    const admin = await requireAdmin(request);
    const { id } = await context.params;
    const result = await processWithdrawal({ withdrawalId: id, decision: "PROCESSING", adminId: admin.id, adminRole: admin.role, meta: getRequestMetadata(request) });
    return jsonOk(result, "Withdrawal masuk PROCESSING untuk percobaan berikutnya.");
  } catch (error) {
    return errorResponse(error);
  }
}
