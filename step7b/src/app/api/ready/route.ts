import { db } from "@/db";
import { sql } from "drizzle-orm";
import { log } from "@/server/services/observability";
import { runtimeStatus } from "@/server/runtime-lifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id");
  try {
    const runtime = runtimeStatus();
    if (runtime.draining) return Response.json({ ok: false, database: false, draining: true, requestId, timestamp: new Date().toISOString() }, { status: 503, headers: { "Cache-Control": "no-store" } });
    await db.execute(sql`SELECT 1`);
    return Response.json({ ok: true, database: true, draining: false, requestId, timestamp: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    log("ERROR", "readiness_failed", { requestId, error });
    return Response.json({ ok: false, database: false, requestId, timestamp: new Date().toISOString() }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
