import { and, eq, ne, sql } from "drizzle-orm";
import { readDb } from "@/db";
import { arisanParticipants, arisanPeriods, arisanTypes } from "@/db/schema";
import { errorResponse, jsonOk } from "@/server/http";
import { withCacheControl, PUBLIC_REFERENCE_CACHE_CONTROL } from "@/server/cache-policy";
import { cursorWhere, decodeCursor, encodeCursor, parsePageSize } from "@/server/pagination";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const pageSize = parsePageSize(params.get("limit"), 20, 100);
    const cursor = decodeCursor(params.get("cursor"));
    const rows = await readDb
      .select({
        id: arisanPeriods.id,
        code: arisanPeriods.code,
        typeId: arisanPeriods.typeId,
        name: arisanTypes.name,
        description: arisanTypes.description,
        contributionAmount: arisanPeriods.contributionAmount,
        minimumParticipants: arisanPeriods.minimumParticipants,
        maximumParticipants: arisanPeriods.maximumParticipants,
        registrationStartsAt: arisanPeriods.registrationStartsAt,
        registrationEndsAt: arisanPeriods.registrationEndsAt,
        drawingAt: arisanPeriods.drawingAt,
        cancellationDeadlineAt: arisanPeriods.cancellationDeadlineAt,
        status: arisanPeriods.status,
        participantCount: sql<number>`count(${arisanParticipants.id})::int`,
      })
      .from(arisanPeriods)
      .innerJoin(arisanTypes, eq(arisanPeriods.typeId, arisanTypes.id))
      .leftJoin(arisanParticipants, and(eq(arisanParticipants.periodId, arisanPeriods.id), eq(arisanParticipants.status, "ACTIVE")))
      .where(and(eq(arisanTypes.active, true), ne(arisanPeriods.status, "CANCELLED"), cursorWhere(cursor, arisanPeriods.drawingAt, arisanPeriods.id, "asc")))
      .groupBy(arisanPeriods.id, arisanTypes.id)
      .orderBy(sql`${arisanPeriods.drawingAt} ASC`, sql`${arisanPeriods.id} ASC`)
      .limit(pageSize + 1);
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    const response = jsonOk({ periods: page, nextCursor: rows.length > pageSize && last ? encodeCursor(last.drawingAt, last.id) : null });
    return withCacheControl(response, PUBLIC_REFERENCE_CACHE_CONTROL);
  } catch (error) {
    return errorResponse(error);
  }
}
