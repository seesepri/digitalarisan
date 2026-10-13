import { errorResponse, jsonOk, requireSuperAdmin } from "@/server/http";
import { correlateAlerts, getBusinessMetrics, SLO_DEFINITIONS } from "@/server/sre";
import { evaluateAlerts } from "@/server/services/observability";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSuperAdmin(request);
    const snapshot = await getBusinessMetrics();
    const alerts = correlateAlerts(evaluateAlerts(snapshot));
    return jsonOk({ sloDefinitions: SLO_DEFINITIONS, snapshot, alerts }, "SRE observability");
  } catch (error) { return errorResponse(error); }
}
