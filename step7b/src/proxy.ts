import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { recordDuration, recordRequest } from "@/server/metrics";

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

function ensureTraceParent(value: string | null): string {
  if (value && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(value)) return value;
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

export async function proxy(request: NextRequest) {
  const started = Date.now();
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const traceparent = ensureTraceParent(request.headers.get("traceparent"));
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("traceparent", traceparent);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  response.headers.set("traceparent", traceparent);
  response.headers.set("Cache-Control", "no-store");
  recordRequest(request.method, request.nextUrl.pathname);
  recordDuration(Date.now() - started);
  return response;
}

export const config = { matcher: ["/api/:path*"] };
