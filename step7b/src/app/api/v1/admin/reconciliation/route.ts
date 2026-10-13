import { assertSameOrigin, enforceRateLimit, errorResponse, jsonOk, requireAdmin } from "@/server/http";
import { getLatestReconciliation, runAccountingReconciliation } from "@/server/services/reconciliation";

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin(request);
    assertSameOrigin(request);
    await enforceRateLimit(request, "admin-accounting-reconciliation", 5, 60_000, admin.id);
    const url = new URL(request.url);
    const periodId = url.searchParams.get("periodId");
    const result = await runAccountingReconciliation({ periodId });
    return jsonOk({ ...result, executedBy: admin.id }, result.status === "PASS" ? "Reconciliation berhasil: tidak ditemukan mismatch." : "Reconciliation selesai: ditemukan mismatch.", result.status === "PASS" ? 200 : 409);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const periodId = new URL(request.url).searchParams.get("periodId");
    const result = await getLatestReconciliation(periodId);
    return jsonOk(result, result ? "Hasil reconciliation terakhir." : "Belum ada hasil reconciliation.");
  } catch (error) {
    return errorResponse(error);
  }
}
