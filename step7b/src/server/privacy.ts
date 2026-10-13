import { createHash } from "node:crypto";

const SENSITIVE_KEYS = /bank|accountnumber|account_name|accountname|password|token|secret|cookie|authorization|signature|oldvalue|newvalue/i;

export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redactAuditValue(child);
  }
  return out;
}

export function consentEvidenceHash(input: { userId: string; policyType: string; policyVersion: string; granted: boolean; grantedAt: Date }) {
  return createHash("sha256").update(JSON.stringify({ ...input, grantedAt: input.grantedAt.toISOString() })).digest("hex");
}
