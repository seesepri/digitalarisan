import { enforceRateLimit, assertSameOrigin, errorResponse, getRequestMetadata, jsonOk, requireSuperAdmin } from "@/server/http";
import { manuallyRetryJob } from "@/server/services/job-lock";
type RouteContext = { params: Promise<{ jobKey: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const admin = await requireSuperAdmin(request);
    await enforceRateLimit(request, "admin-job-retry", 5, 60_000, admin.id);
    const { jobKey } = await context.params;
    const result = await manuallyRetryJob(jobKey, admin.id, getRequestMetadata(request));
    return jsonOk(result, "Job dijadwalkan ulang.");
  } catch (error) { return errorResponse(error); }
}
