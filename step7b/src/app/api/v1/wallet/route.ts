import { eq } from "drizzle-orm";
import { db } from "@/db";
import { wallets } from "@/db/schema";
import { ApiError, errorResponse, jsonOk, requireUser } from "@/server/http";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, user.id)).limit(1);
    if (!wallet) throw new ApiError("Wallet tidak ditemukan.", "WALLET_NOT_FOUND", 404);
    return jsonOk({
      availableBalance: wallet.availableBalance,
      lockedBalance: wallet.lockedBalance,
      pendingBalance: wallet.pendingBalance,
      totalBalance: wallet.availableBalance + wallet.lockedBalance + wallet.pendingBalance,
      currency: "IDR",
      updatedAt: wallet.updatedAt,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
