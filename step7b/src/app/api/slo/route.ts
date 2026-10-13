import { timingSafeEqual } from "node:crypto";
import { getBusinessMetrics, SLO_DEFINITIONS } from "@/server/sre";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(request: Request): boolean {
  const token = process.env.SRE_TOKEN || process.env.METRICS_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token || !supplied) return false;
  const a = Buffer.from(token); const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!authorized(request)) return new Response("Unauthorized\n", { status: 401, headers: { "Cache-Control": "no-store" } });
  const business = await getBusinessMetrics();
  return Response.json({ service: "digital-arisan", generatedAt: new Date().toISOString(), sloDefinitions: SLO_DEFINITIONS, business, errorBudgetPolicy: "30d rolling window; burn-rate alerts are evaluated by the monitoring system" }, { headers: { "Cache-Control": "no-store" } });
}
