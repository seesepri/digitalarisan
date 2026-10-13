import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { ApiError } from "@/server/http";
import { auditLogs, jobExecutions, users } from "@/db/schema";

const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export type JobLease = {
  id: string;
  jobKey: string;
  leaseToken: string;
  attemptCount: number;
  maxAttempts: number;
  lockedUntil: Date;
};

function retryDelayMs(attempt: number): number {
  const schedule = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
  return schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)];
}

export async function acquireJobLease(input: {
  jobKey: string;
  now?: Date;
  leaseMs?: number;
  maxAttempts?: number;
}): Promise<JobLease | null> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const token = randomUUID();
  const lockedUntil = new Date(now.getTime() + leaseMs);

  const result = await db.execute(sql`
    INSERT INTO job_executions
      (id, job_key, status, lease_token, locked_until, attempt_count, max_attempts, next_run_at, started_at, updated_at)
    VALUES
      (${randomUUID()}, ${input.jobKey}, 'RUNNING', ${token}, ${lockedUntil}, 1, ${maxAttempts}, NULL, ${now}, ${now})
    ON CONFLICT (job_key) DO UPDATE SET
      status = 'RUNNING',
      lease_token = ${token},
      locked_until = ${lockedUntil},
      attempt_count = job_executions.attempt_count + 1,
      max_attempts = GREATEST(job_executions.max_attempts, ${maxAttempts}),
      next_run_at = NULL,
      started_at = ${now},
      finished_at = NULL,
      updated_at = ${now}
    WHERE
      (job_executions.status <> 'RUNNING' OR job_executions.locked_until IS NULL OR job_executions.locked_until <= ${now})
      AND (job_executions.next_run_at IS NULL OR job_executions.next_run_at <= ${now})
      AND job_executions.attempt_count < job_executions.max_attempts
    RETURNING id, job_key, lease_token, attempt_count, max_attempts, locked_until
  `);

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    jobKey: String(row.job_key),
    leaseToken: String(row.lease_token),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    lockedUntil: new Date(String(row.locked_until)),
  };
}

export async function renewJobLease(lease: JobLease, leaseMs = DEFAULT_LEASE_MS): Promise<boolean> {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + leaseMs);
  const result = await db
    .update(jobExecutions)
    .set({ lockedUntil, updatedAt: now })
    .where(and(eq(jobExecutions.id, lease.id), eq(jobExecutions.leaseToken, lease.leaseToken), eq(jobExecutions.status, "RUNNING"), gt(jobExecutions.lockedUntil, now)))
    .returning({ id: jobExecutions.id });
  if (result.length === 0) return false;
  lease.lockedUntil = lockedUntil;
  return true;
}

export async function completeJob(lease: JobLease): Promise<void> {
  const now = new Date();
  const updated = await db
    .update(jobExecutions)
    .set({ status: "SUCCESS", leaseToken: null, lockedUntil: null, nextRunAt: null, attemptCount: 0, finishedAt: now, updatedAt: now, lastErrorCode: null, lastErrorMessage: null })
    .where(and(eq(jobExecutions.id, lease.id), eq(jobExecutions.leaseToken, lease.leaseToken), eq(jobExecutions.status, "RUNNING"), gt(jobExecutions.lockedUntil, now))).returning({ id: jobExecutions.id });
  if (!updated.length) throw new ApiError("Lease job telah hilang atau kedaluwarsa.", "JOB_LEASE_LOST", 409);
}

export async function failJob(lease: JobLease, input: { errorCode: string; errorMessage: string }): Promise<{ retryable: boolean; nextRunAt: Date | null }> {
  const now = new Date();
  const retryable = lease.attemptCount < lease.maxAttempts;
  const nextRunAt = retryable ? new Date(now.getTime() + retryDelayMs(lease.attemptCount)) : null;
  const status = retryable ? "FAILED" : "FAILED_FINAL";
  const updated = await db
    .update(jobExecutions)
    .set({ status, leaseToken: null, lockedUntil: null, nextRunAt, finishedAt: now, updatedAt: now, lastErrorCode: input.errorCode, lastErrorMessage: input.errorMessage })
    .where(and(eq(jobExecutions.id, lease.id), eq(jobExecutions.leaseToken, lease.leaseToken), eq(jobExecutions.status, "RUNNING"), gt(jobExecutions.lockedUntil, now))).returning({ id: jobExecutions.id });
  if (!updated.length) throw new ApiError("Lease job telah hilang atau kedaluwarsa.", "JOB_LEASE_LOST", 409);
  return { retryable, nextRunAt };
}

export async function getJobExecution(jobKey: string) {
  const [job] = await db.select().from(jobExecutions).where(eq(jobExecutions.jobKey, jobKey)).limit(1);
  return job ?? null;
}

export { DEFAULT_LEASE_MS, DEFAULT_MAX_ATTEMPTS, retryDelayMs };


export async function manuallyRetryJob(jobKey: string, actorId: string, meta?: { ipAddress?: string | null; userAgent?: string | null }) {
  return db.transaction(async (tx) => {
    const [actor] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, actorId)).limit(1);
    if (!actor || actor.role !== "SUPER_ADMIN" || actor.status !== "ACTIVE") throw new ApiError("Retry job memerlukan super administrator aktif.", "FORBIDDEN", 403);
    const [job] = await tx.select().from(jobExecutions).where(eq(jobExecutions.jobKey, jobKey)).for("update").limit(1);
    if (!job) throw new ApiError("Job tidak ditemukan.", "JOB_NOT_FOUND", 404);
    const now = new Date();
    if (job.status === "RUNNING" && (!job.lockedUntil || job.lockedUntil > now)) throw new ApiError("Job masih memiliki lease aktif; jangan memulai worker kedua.", "JOB_ALREADY_RUNNING", 409);
    const [result] = await tx.update(jobExecutions).set({ status: "FAILED", leaseToken: null, lockedUntil: null, attemptCount: 0, nextRunAt: now, finishedAt: null, updatedAt: now }).where(eq(jobExecutions.id, job.id)).returning({ id: jobExecutions.id, jobKey: jobExecutions.jobKey, status: jobExecutions.status, nextRunAt: jobExecutions.nextRunAt });
    await tx.insert(auditLogs).values({ actorId, actorType: "SUPER_ADMIN", action: "JOB_MANUALLY_RETRIED", entityType: "job_execution", entityId: job.id, ipAddress: meta?.ipAddress ?? null, userAgent: meta?.userAgent ?? null, oldValue: { status: job.status }, newValue: { jobKey, status: result.status } });
    return result;
  });
}
