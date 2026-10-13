import { enforceRateLimit, assertSameOrigin, errorResponse, getIdempotencyKey, getRequestMetadata, jsonOk, readJson, requireUser } from "@/server/http";
import { cancelParticipation } from "@/server/services/arisan";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    await enforceRateLimit(request, "arisan-cancel", 15, 60_000, user.id);
    const body = await readJson(request);
    const idempotencyKey = getIdempotencyKey(request, body);
    const { id } = await context.params;
    const result = await cancelParticipation({
      participantId: id,
      userId: user.id,
      idempotencyKey,
      meta: getRequestMetadata(request),
    });
    return jsonOk(result, result.replayed ? "Pembatalan sudah diproses sebelumnya." : "Kepesertaan dibatalkan dan iuran dikembalikan.");
  } catch (error) {
    return errorResponse(error);
  }
}
