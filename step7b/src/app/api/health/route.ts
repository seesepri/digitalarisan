
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id");
  return Response.json({ ok: true, service: "digital-arisan", requestId, timestamp: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}

export async function HEAD() { return new Response(null, { status: 200 }); }
