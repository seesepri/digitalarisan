import { randomBytes } from "node:crypto";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function hex(bytes: number): string { return randomBytes(bytes).toString("hex"); }

export function newTraceParent(): string {
  return `00-${hex(16)}-${hex(8)}-01`;
}

export function childTraceParent(parent?: string | null): string {
  const match = parent?.match(TRACEPARENT);
  if (!match) return newTraceParent();
  return `00-${match[1]}-${hex(8)}-01`;
}

export function traceIds(traceparent?: string | null): { traceId: string; spanId: string } | null {
  const match = traceparent?.match(TRACEPARENT);
  return match ? { traceId: match[1], spanId: match[2] } : null;
}
