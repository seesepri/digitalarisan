import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { arisanPeriods, arisanTypes, auditLogs } from "@/db/schema";
import { ApiError, assertSameOrigin, errorResponse, getRequestMetadata, jsonOk, positiveInteger, readJson, requireAdmin, requireSuperAdmin, requiredString } from "@/server/http";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const types = await db
      .select({
        id: arisanTypes.id,
        name: arisanTypes.name,
        description: arisanTypes.description,
        contributionAmount: arisanTypes.contributionAmount,
        minimumParticipants: arisanTypes.minimumParticipants,
        maximumParticipants: arisanTypes.maximumParticipants,
        cancellationDeadlineDays: arisanTypes.cancellationDeadlineDays,
        platformFeeBps: arisanTypes.platformFeeBps,
        active: arisanTypes.active,
        periodCount: sql<number>`(select count(*)::int from arisan_periods p where p.type_id = ${arisanTypes.id})`,
      })
      .from(arisanTypes)
      .orderBy(arisanTypes.createdAt);
    return jsonOk({ types });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await requireSuperAdmin(request);
    const body = await readJson(request);
    const name = requiredString(body.name, "Nama jenis arisan", 3, 120);
    const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "";
    const contributionAmount = positiveInteger(body.contributionAmount, "Iuran", 50_000_000);
    const minimumParticipants = positiveInteger(body.minimumParticipants, "Peserta minimum", 500);
    const maximumParticipants = positiveInteger(body.maximumParticipants, "Peserta maksimum", 500);
    const cancellationDeadlineDays = positiveInteger(body.cancellationDeadlineDays ?? 2, "Hari batas pembatalan", 30);
    const platformFeeBps = body.platformFeeBps === undefined ? 0 : Number(body.platformFeeBps);
    if (minimumParticipants < 2 || maximumParticipants < minimumParticipants) {
      throw new ApiError("Batas peserta tidak valid.", "VALIDATION_ERROR", 400);
    }
    if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 9999) {
      throw new ApiError("Fee harus berupa basis point antara 0 dan 9.999.", "VALIDATION_ERROR", 400);
    }
    const meta = getRequestMetadata(request);
    const result = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(arisanTypes)
        .values({
          name,
          description,
          contributionAmount,
          minimumParticipants,
          maximumParticipants,
          cancellationDeadlineDays,
          platformFeeBps,
          active: true,
          drawingMethod: "CSPRNG",
        })
        .returning();
      await tx.insert(auditLogs).values({
        actorId: admin.id,
        actorType: admin.role,
        action: "ARISAN_TYPE_CREATED",
        entityType: "arisan_type",
        entityId: created.id,
        newValue: { name, contributionAmount, minimumParticipants, maximumParticipants, cancellationDeadlineDays, platformFeeBps },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return created;
    });
    return jsonOk({ type: result }, "Jenis arisan berhasil dibuat.", 201);
  } catch (error) {
    return errorResponse(error);
  }
}
