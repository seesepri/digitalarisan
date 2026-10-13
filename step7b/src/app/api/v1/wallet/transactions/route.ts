import { errorResponse, jsonOk, requireUser } from "@/server/http";
import { listWalletTransactions } from "@/server/services/wallet";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? "30");
    const transactions = await listWalletTransactions(user.id, Number.isFinite(limit) ? Math.trunc(limit) : 30, params.get("cursor"));
    const response = jsonOk(transactions);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
