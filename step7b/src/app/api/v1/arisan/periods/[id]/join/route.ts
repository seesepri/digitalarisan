import { assertSameOrigin, errorResponse, getIdempotencyKey, getRequestMetadata, jsonOk, readJson, requireUser } from "@/server/http";
import { joinPeriod } from "@/server/services/arisan";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const body = await readJson(request);
    const idempotencyKey = getIdempotencyKey(request, body);
    const { id } = await context.params;
    const result = await joinPeriod({
      periodId: id,
      userId: user.id,
      idempotencyKey,
      meta: getRequestMetadata(request),
    });
    return jsonOk(result, result.replayed ? "Permintaan join sebelumnya sudah diproses." : "Berhasil bergabung. Iuran telah dikunci.", result.replayed ? 200 : 201);
  } catch (error) {
    return errorResponse(error);
  }
}
