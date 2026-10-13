import { assertSameOrigin, enforceRateLimit, errorResponse, getRequestMetadata, jsonOk, readJson, requireAdmin, requiredString } from "@/server/http";
import { approveWithdrawal } from "@/server/services/compliance";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    await enforceRateLimit(request, "admin-financial-withdrawal-approve", 20, 60_000);
    const admin = await requireAdmin(request);
    const { id } = await context.params;
    const body = await readJson(request);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
    if (!reason) requiredString(body.reason, "Alasan approval", 5, 500);
    const result = await approveWithdrawal({ withdrawalId: id, adminId: admin.id, reason, ...getRequestMetadata(request) });
    return jsonOk(result, result.replayed ? "Approval withdrawal sudah tercatat." : "Withdrawal berhasil di-approve.");
  } catch (error) {
    return errorResponse(error);
  }
}
