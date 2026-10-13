import { db } from "@/db";
import { sql } from "drizzle-orm";

export type LogLevel = "INFO" | "WARN" | "ERROR";

function redactString(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1[REDACTED]")
    .replace(/(cookie\s*[:=]\s*)[^,}]+/gi, "$1[REDACTED]")
    .replace(/(refresh_token|access_token|password|server[_-]?key|api[_-]?key|secret|signature|account[_-]?number|bank[_-]?name|account[_-]?name)\s*[:=]\s*[^,}\s]+/gi, "$1=[REDACTED]");
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), stack: redactString(value.stack ?? "") };
  if (typeof value === "string") return redactString(value).slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/password|token|secret|api.?key|authorization|cookie|signature|account.?number|bank.?name|account.?name|refresh.?token|access.?token/i.test(key)) out[key] = "[REDACTED]";
      else out[key] = redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

function serialize(value: unknown): unknown {
  return redact(value);
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "digital-arisan",
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, serialize(value)])),
  });
  if (level === "ERROR") console.error(entry);
  else if (level === "WARN") console.warn(entry);
  else console.info(entry);
}

export async function getOperationalSnapshot() {
  const dbResult = await db.execute(sql`SELECT 1 AS ok`);
  const stuckTopups = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM topups
    WHERE status IN ('PENDING', 'PROCESSING')
      AND updated_at < NOW() - INTERVAL '15 minutes'
  `);
  const stuckWithdrawals = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM withdrawals
    WHERE status IN ('PENDING', 'PROCESSING')
      AND updated_at < NOW() - INTERVAL '30 minutes'
  `);
  const failedJobs = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM job_executions
    WHERE status = 'FAILED_FINAL'
  `);
  const expiredLeases = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM job_executions
    WHERE status = 'RUNNING' AND locked_until < NOW()
  `);
  const failedReconciliation = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM reconciliation_runs
    WHERE status = 'FAIL'
      AND created_at > NOW() - INTERVAL '24 hours'
  `);
  const recentPaymentFailures = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM topups
    WHERE status = 'FAILED'
      AND updated_at > NOW() - INTERVAL '15 minutes'
  `);
  const recentWithdrawalFailures = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM withdrawals
    WHERE status IN ('FAILED_RETRYABLE', 'FAILED_FINAL')
      AND updated_at > NOW() - INTERVAL '15 minutes'
  `);
  const activeUsers = await db.execute(sql`SELECT COUNT(*)::int AS count FROM users WHERE status = 'ACTIVE'`);
  const openPeriods = await db.execute(sql`SELECT COUNT(*)::int AS count FROM arisan_periods WHERE status IN ('OPEN', 'FULL', 'LOCKED', 'DRAWING', 'PAYOUT_PROCESSING')`);
  const activeParticipants = await db.execute(sql`SELECT COUNT(*)::int AS count FROM arisan_participants WHERE status = 'ACTIVE'`);
  const successfulTopups24h = await db.execute(sql`SELECT COUNT(*)::int AS count FROM topups WHERE status = 'SUCCESS' AND updated_at > NOW() - INTERVAL '24 hours'`);
  const successfulWithdrawals24h = await db.execute(sql`SELECT COUNT(*)::int AS count FROM withdrawals WHERE status = 'SUCCESS' AND updated_at > NOW() - INTERVAL '24 hours'`);
  const completedPeriods24h = await db.execute(sql`SELECT COUNT(*)::int AS count FROM arisan_periods WHERE status = 'COMPLETED' AND updated_at > NOW() - INTERVAL '24 hours'`);

  return {
    database: Boolean(dbResult.rows.length),
    stuckTopups: Number((stuckTopups.rows[0] as { count: number } | undefined)?.count ?? 0),
    stuckWithdrawals: Number((stuckWithdrawals.rows[0] as { count: number } | undefined)?.count ?? 0),
    failedFinalJobs: Number((failedJobs.rows[0] as { count: number } | undefined)?.count ?? 0),
    expiredJobLeases: Number((expiredLeases.rows[0] as { count: number } | undefined)?.count ?? 0),
    failedReconciliations24h: Number((failedReconciliation.rows[0] as { count: number } | undefined)?.count ?? 0),
    recentPaymentFailures: Number((recentPaymentFailures.rows[0] as { count: number } | undefined)?.count ?? 0),
    recentWithdrawalFailures: Number((recentWithdrawalFailures.rows[0] as { count: number } | undefined)?.count ?? 0),
    activeUsers: Number((activeUsers.rows[0] as { count: number } | undefined)?.count ?? 0),
    openPeriods: Number((openPeriods.rows[0] as { count: number } | undefined)?.count ?? 0),
    activeParticipants: Number((activeParticipants.rows[0] as { count: number } | undefined)?.count ?? 0),
    successfulTopups24h: Number((successfulTopups24h.rows[0] as { count: number } | undefined)?.count ?? 0),
    successfulWithdrawals24h: Number((successfulWithdrawals24h.rows[0] as { count: number } | undefined)?.count ?? 0),
    completedPeriods24h: Number((completedPeriods24h.rows[0] as { count: number } | undefined)?.count ?? 0),
    checkedAt: new Date().toISOString(),
  };
}

export { evaluateOperationalAlerts as evaluateAlerts } from "@/server/observability-alerts";
