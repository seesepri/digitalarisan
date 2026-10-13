import { timingSafeEqual } from "node:crypto";
import { prometheusText } from "@/server/metrics";
import { getOperationalSnapshot } from "@/server/services/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  const configured = process.env.METRICS_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!configured || !supplied || !constantTimeEqual(supplied, configured)) {
    return new Response("Unauthorized\n", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const snapshot = await getOperationalSnapshot();
  return new Response(prometheusText(snapshot), { status: 200, headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } });
}
