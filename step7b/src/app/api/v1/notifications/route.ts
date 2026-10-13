import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { errorResponse, jsonOk, requireUser } from "@/server/http";
import { cursorWhere, decodeCursor, encodeCursor, parsePageSize } from "@/server/pagination";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const pageSize = parsePageSize(params.get("limit"), 50, 100);
    const cursor = decodeCursor(params.get("cursor"));
    const rows = await db
      .select({
        id: notifications.id,
        title: notifications.title,
        message: notifications.message,
        type: notifications.type,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        referenceType: notifications.referenceType,
        referenceId: notifications.referenceId,
      })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), cursorWhere(cursor, notifications.createdAt, notifications.id)))
      .orderBy(sql`${notifications.createdAt} DESC`, sql`${notifications.id} DESC`)
      .limit(pageSize + 1);
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    const response = jsonOk({ notifications: page, nextCursor: rows.length > pageSize && last ? encodeCursor(last.createdAt, last.id) : null });
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
