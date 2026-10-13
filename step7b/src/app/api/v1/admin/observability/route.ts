import { errorResponse, jsonOk, requireSuperAdmin } from "@/server/http";
import { evaluateAlerts, getOperationalSnapshot } from "@/server/services/observability";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSuperAdmin(request);
    const snapshot = await getOperationalSnapshot();
    return jsonOk({ snapshot, alerts: evaluateAlerts(snapshot) }, "Operational observability");
  } catch (error) {
    return errorResponse(error);
  }
}
