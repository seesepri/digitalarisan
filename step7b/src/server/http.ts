import { createHash, createHmac } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimitBuckets, userSessions, users } from "@/db/schema";
import { readCookie, verifyAccessToken } from "@/server/auth";
import { log } from "@/server/services/observability";
import { applyApiContractHeaders } from "@/server/api-governance";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type AuthenticatedUser = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: "USER" | "ADMIN" | "SUPER_ADMIN";
  status: "ACTIVE" | "SUSPENDED" | "PENDING";
  sessionId: string;
};

type Envelope<T> = { success: true; data: T; message: string };

export function jsonOk<T>(data: T, message = "Success", status = 200): Response {
  const body: Envelope<T> = { success: true, data, message };
  return applyApiContractHeaders(Response.json(body, { status, headers: { "Cache-Control": "no-store" } }));
}

export function jsonError(message: string, code: string, status = 400): Response {
  return applyApiContractHeaders(Response.json(
    { success: false, message, code },
    { status, headers: { "Cache-Control": "no-store" } },
  ));
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return jsonError(error.message, error.code, error.status);
  if (error && typeof error === "object" && "code" in error && "status" in error && typeof (error as { code?: unknown }).code === "string" && typeof (error as { status?: unknown }).status === "number") {
    return jsonError(error instanceof Error ? error.message : "Service temporarily unavailable.", String((error as { code: string }).code), Number((error as { status: number }).status));
  }
  log("ERROR", "unhandled_api_error", { error });
  return jsonError("Terjadi kesalahan pada server.", "INTERNAL_ERROR", 500);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError("Format request tidak valid.", "INVALID_BODY", 400);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("Body JSON tidak valid.", "INVALID_JSON", 400);
  }
}

export async function requireUser(request: Request): Promise<AuthenticatedUser> {
  const token = readCookie(request, "access_token");
  if (!token) throw new ApiError("Silakan masuk untuk melanjutkan.", "UNAUTHORIZED", 401);
  const claims = verifyAccessToken(token);
  if (!claims) throw new ApiError("Sesi tidak valid atau telah berakhir.", "INVALID_SESSION", 401);

  const [record] = await db
    .select({
      id: users.id,
      name: users.name,
      phone: users.phone,
      email: users.email,
      role: users.role,
      status: users.status,
      phoneVerifiedAt: users.phoneVerifiedAt,
      sessionId: userSessions.id,
    })
    .from(userSessions)
    .innerJoin(users, eq(userSessions.userId, users.id))
    .where(
      and(
        eq(userSessions.id, claims.sid),
        eq(userSessions.userId, claims.sub),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!record || record.status !== "ACTIVE") {
    throw new ApiError("Akun atau sesi tidak aktif.", "SESSION_REVOKED", 401);
  }
  if (!record.phoneVerifiedAt) throw new ApiError("Verifikasi nomor HP diperlukan untuk melanjutkan.", "PHONE_VERIFICATION_REQUIRED", 403);
  return record;
}

export async function requireAdmin(request: Request): Promise<AuthenticatedUser & { role: "ADMIN" | "SUPER_ADMIN" }> {
  const user = await requireUser(request);
  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") {
    throw new ApiError("Akses administrator diperlukan.", "FORBIDDEN", 403);
  }
  return user as AuthenticatedUser & { role: "ADMIN" | "SUPER_ADMIN" };
}

export async function requireSuperAdmin(request: Request): Promise<AuthenticatedUser & { role: "SUPER_ADMIN" }> {
  const user = await requireUser(request);
  if (user.role !== "SUPER_ADMIN") throw new ApiError("Akses super administrator diperlukan.", "FORBIDDEN", 403);
  return user as AuthenticatedUser & { role: "SUPER_ADMIN" };
}

export function assertSameOrigin(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") throw new ApiError("Permintaan lintas situs ditolak.", "CSRF_REJECTED", 403);
  const origin = request.headers.get("origin");
  if (!origin) {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError("Origin wajib disertakan untuk permintaan mutasi.", "CSRF_REJECTED", 403);
    }
    return;
  }
  let originUrl: URL;
  try { originUrl = new URL(origin); } catch { throw new ApiError("Origin tidak valid.", "CSRF_REJECTED", 403); }
  const allowed = new Set<string>([new URL(request.url).origin]);
  if (process.env.APP_URL) {
    try { allowed.add(new URL(process.env.APP_URL).origin); } catch { throw new ApiError("APP_URL tidak valid.", "SERVER_CONFIGURATION_ERROR", 500); }
  }
  if (!allowed.has(originUrl.origin)) throw new ApiError("Origin permintaan tidak diizinkan.", "CSRF_REJECTED", 403);
}

function clientIdentity(request: Request): string {
  if (process.env.TRUST_PROXY !== "true") return "direct";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  return (forwarded || real || "unknown").slice(0, 120);
}

export async function enforceRateLimit(request: Request, action: string, maximum = 12, windowMs = 60_000, subject?: string): Promise<void> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || !Number.isSafeInteger(windowMs) || windowMs < 1000) {
    throw new ApiError("Konfigurasi rate limit tidak valid.", "SERVER_CONFIGURATION_ERROR", 500);
  }
  if (process.env.NODE_ENV === "production" && process.env.TRUST_PROXY !== "true") {
    throw new ApiError("TRUST_PROXY=true wajib di production agar rate limit tidak mempercayai header spoofed.", "SERVER_CONFIGURATION_ERROR", 500);
  }
  const identity = clientIdentity(request);
  const subjectKey = subject ? createHmac("sha256", process.env.AUTH_SECRET ?? "development-rate-limit-key").update(subject).digest("hex") : "";
  const key = `${action}:${identity}:${subjectKey}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowMs);
  const result = await db.execute(sql`
    INSERT INTO rate_limit_buckets (bucket_key, count, window_started_at, expires_at, updated_at)
    VALUES (${key}, 1, ${now}, ${expiresAt}, ${now})
    ON CONFLICT (bucket_key) DO UPDATE SET
      count = CASE WHEN rate_limit_buckets.expires_at <= ${now} THEN 1 ELSE rate_limit_buckets.count + 1 END,
      window_started_at = CASE WHEN rate_limit_buckets.expires_at <= ${now} THEN ${now} ELSE rate_limit_buckets.window_started_at END,
      expires_at = CASE WHEN rate_limit_buckets.expires_at <= ${now} THEN ${expiresAt} ELSE rate_limit_buckets.expires_at END,
      updated_at = ${now}
    RETURNING count, expires_at
  `);
  const row = result.rows[0] as { count: number; expires_at: Date | string } | undefined;
  if (!row) throw new ApiError("Rate limiter gagal diproses.", "RATE_LIMIT_UNAVAILABLE", 503);
  if (Number(row.count) > maximum) throw new ApiError("Terlalu banyak permintaan. Coba lagi sebentar.", "RATE_LIMITED", 429);
  if (Math.random() < 0.01) {
    await db.execute(sql`DELETE FROM rate_limit_buckets WHERE bucket_key IN (SELECT bucket_key FROM rate_limit_buckets WHERE expires_at < ${now} LIMIT 1000)`);
  }
}

export function getRequestMetadata(request: Request): { ipAddress: string | null; userAgent: string | null } {
  const ipAddress = process.env.TRUST_PROXY === "true"
    ? (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null)
    : null;
  return { ipAddress: ipAddress?.slice(0, 64) ?? null, userAgent: request.headers.get("user-agent")?.slice(0, 1000) ?? null };
}

export function getIdempotencyKey(request: Request, body: Record<string, unknown>): string {
  const key = request.headers.get("idempotency-key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "");
  if (key.length < 8 || key.length > 180 || !/^[\w.:/-]+$/.test(key)) {
    throw new ApiError("Header Idempotency-Key yang valid diperlukan.", "IDEMPOTENCY_KEY_REQUIRED", 400);
  }
  return key;
}

export function requiredString(value: unknown, field: string, min = 1, max = 255): string {
  if (typeof value !== "string") throw new ApiError(`${field} wajib diisi.`, "VALIDATION_ERROR", 400);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ApiError(`${field} harus terdiri dari ${min} sampai ${max} karakter.`, "VALIDATION_ERROR", 400);
  }
  return normalized;
}

export function positiveInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const amount = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > maximum) {
    throw new ApiError(`${field} harus berupa bilangan bulat positif.`, "VALIDATION_ERROR", 400);
  }
  return amount;
}
