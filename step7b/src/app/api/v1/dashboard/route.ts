import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { arisanParticipants, arisanPeriods, arisanTypes, notifications, wallets } from "@/db/schema";
import { errorResponse, jsonOk, requireUser } from "@/server/http";
import { listWalletTransactions } from "@/server/services/wallet";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, user.id)).limit(1);
    const activeCounts = db
      .select({ periodId: arisanParticipants.periodId, count: sql<number>`count(*)::int`.as("count") })
      .from(arisanParticipants)
      .where(eq(arisanParticipants.status, "ACTIVE"))
      .groupBy(arisanParticipants.periodId)
      .as("active_counts");
    const memberships = await db
      .select({
        participantId: arisanParticipants.id,
        periodId: arisanPeriods.id,
        periodCode: arisanPeriods.code,
        name: arisanTypes.name,
        contributionAmount: arisanParticipants.contributionAmount,
        participantStatus: arisanParticipants.status,
        periodStatus: arisanPeriods.status,
        drawingAt: arisanPeriods.drawingAt,
        cancellationDeadlineAt: arisanPeriods.cancellationDeadlineAt,
        maximumParticipants: arisanPeriods.maximumParticipants,
        participantCount: sql<number>`coalesce(${activeCounts.count}, 0)`,
      })
      .from(arisanParticipants)
      .innerJoin(arisanPeriods, eq(arisanParticipants.periodId, arisanPeriods.id))
      .innerJoin(arisanTypes, eq(arisanPeriods.typeId, arisanTypes.id))
      .leftJoin(activeCounts, eq(activeCounts.periodId, arisanPeriods.id))
      .where(and(eq(arisanParticipants.userId, user.id), inArray(arisanParticipants.status, ["ACTIVE", "WINNER", "COMPLETED"])))
      .orderBy(sql`${arisanPeriods.drawingAt} DESC`)
      .limit(10);
    const [unreadResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), sql`${notifications.readAt} IS NULL`));
    const recentTransactions = await listWalletTransactions(user.id, 5);
    const response = jsonOk({
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role },
      wallet: wallet
        ? {
            availableBalance: wallet.availableBalance,
            lockedBalance: wallet.lockedBalance,
            pendingBalance: wallet.pendingBalance,
            totalBalance: wallet.availableBalance + wallet.lockedBalance + wallet.pendingBalance,
          }
        : { availableBalance: 0, lockedBalance: 0, pendingBalance: 0, totalBalance: 0 },
      memberships,
      recentTransactions: recentTransactions.transactions,
      unreadNotifications: unreadResult?.count ?? 0,
    });
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
