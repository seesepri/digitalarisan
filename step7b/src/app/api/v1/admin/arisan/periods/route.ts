import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { arisanParticipants, arisanPeriods, arisanTypes, auditLogs } from "@/db/schema";
import { ApiError, assertSameOrigin, errorResponse, getRequestMetadata, jsonOk, readJson, requireAdmin, requireSuperAdmin, requiredString } from "@/server/http";

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.length > 80) throw new ApiError(`${field} tidak valid.`, "VALIDATION_ERROR", 400);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError(`${field} tidak valid.`, "VALIDATION_ERROR", 400);
  return date;
}

function jakartaEndOfDayBefore(drawingAt: Date, days: number): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(drawingAt);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return new Date(Date.UTC(year, month - 1, day - days, 16, 59, 59, 999));
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const periods = await db
      .select({
        id: arisanPeriods.id,
        code: arisanPeriods.code,
        name: arisanTypes.name,
        contributionAmount: arisanPeriods.contributionAmount,
        minimumParticipants: arisanPeriods.minimumParticipants,
        maximumParticipants: arisanPeriods.maximumParticipants,
        registrationStartsAt: arisanPeriods.registrationStartsAt,
        registrationEndsAt: arisanPeriods.registrationEndsAt,
        drawingAt: arisanPeriods.drawingAt,
        cancellationDeadlineAt: arisanPeriods.cancellationDeadlineAt,
        status: arisanPeriods.status,
        participantCount: sql<number>`(select count(*)::int from arisan_participants p where p.period_id = ${arisanPeriods.id} and p.status = 'ACTIVE')`,
      })
      .from(arisanPeriods)
      .innerJoin(arisanTypes, eq(arisanPeriods.typeId, arisanTypes.id))
      .orderBy(sql`${arisanPeriods.drawingAt} DESC`)
      .limit(100);
    return jsonOk({ periods });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await requireSuperAdmin(request);
    const body = await readJson(request);
    const typeId = requiredString(body.typeId, "Jenis arisan", 36, 36);
    const code = requiredString(body.code, "Kode periode", 5, 64).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]+$/.test(code)) throw new ApiError("Format kode periode tidak valid.", "VALIDATION_ERROR", 400);
    const registrationStartsAt = parseDate(body.registrationStartsAt, "Waktu mulai pendaftaran");
    const registrationEndsAt = parseDate(body.registrationEndsAt, "Waktu akhir pendaftaran");
    const drawingAt = parseDate(body.drawingAt, "Waktu drawing");
    const status = body.status === "OPEN" ? "OPEN" : body.status === undefined || body.status === "DRAFT" ? "DRAFT" : null;
    if (!status) throw new ApiError("Status awal hanya boleh DRAFT atau OPEN.", "VALIDATION_ERROR", 400);
    const metadata = getRequestMetadata(request);
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM arisan_types WHERE id = ${typeId} FOR UPDATE`);
      const [type] = await tx.select().from(arisanTypes).where(eq(arisanTypes.id, typeId)).limit(1);
      if (!type || !type.active) throw new ApiError("Jenis arisan tidak aktif atau tidak ditemukan.", "ARISAN_TYPE_NOT_FOUND", 404);
      const deadline = jakartaEndOfDayBefore(drawingAt, type.cancellationDeadlineDays);
      if (registrationStartsAt >= registrationEndsAt || registrationEndsAt > deadline || deadline >= drawingAt) {
        throw new ApiError("Jadwal pendaftaran, batas pembatalan, dan drawing tidak valid.", "INVALID_PERIOD_SCHEDULE", 400);
      }
      const [period] = await tx
        .insert(arisanPeriods)
        .values({
          typeId: type.id,
          code,
          registrationStartsAt,
          registrationEndsAt,
          drawingAt,
          cancellationDeadlineAt: deadline,
          minimumParticipants: type.minimumParticipants,
          maximumParticipants: type.maximumParticipants,
          contributionAmount: type.contributionAmount,
          platformFeeBps: type.platformFeeBps,
          status,
        })
        .returning();
      await tx.insert(auditLogs).values({
        actorId: admin.id,
        actorType: admin.role,
        action: "ARISAN_PERIOD_CREATED",
        entityType: "arisan_period",
        entityId: period.id,
        newValue: { code, typeId: type.id, status, drawingAt: drawingAt.toISOString(), cancellationDeadlineAt: deadline.toISOString() },
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
      });
      return period;
    });
    return jsonOk({ period: created }, "Periode arisan berhasil dibuat.", 201);
  } catch (error) {
    return errorResponse(error);
  }
}
