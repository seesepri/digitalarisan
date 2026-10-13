import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { assertSameOrigin, errorResponse, jsonOk, requireUser } from "@/server/http";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, user.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return jsonOk({ id, read: true, changed: Boolean(updated) }, "Notifikasi ditandai telah dibaca.");
  } catch (error) {
    return errorResponse(error);
  }
}
