import { sql } from "drizzle-orm";
import { db } from "@/db";
import { arisanParticipants, arisanPeriods, payouts, topups, users, wallets, withdrawals } from "@/db/schema";
import { errorResponse, jsonOk, requireAdmin } from "@/server/http";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const [userMetrics] = await db.select({
      totalUsers: sql<number>`count(*)::int`,
      activeUsers: sql<number>`count(*) filter (where status = 'ACTIVE')::int`,
      suspendedUsers: sql<number>`count(*) filter (where status = 'SUSPENDED')::int`,
    }).from(users);
    const [walletMetrics] = await db.select({
      totalWalletBalance: sql<string>`coalesce(sum(available_balance + locked_balance + pending_balance), 0)::text`,
      totalAvailableBalance: sql<string>`coalesce(sum(available_balance), 0)::text`,
      totalLockedBalance: sql<string>`coalesce(sum(locked_balance), 0)::text`,
      totalPendingBalance: sql<string>`coalesce(sum(pending_balance), 0)::text`,
    }).from(wallets);
    const [periodMetrics] = await db.select({
      activeArisan: sql<number>`count(*) filter (where status in ('OPEN','FULL','LOCKED','DRAWING','PAYOUT_PROCESSING'))::int`,
      completedArisan: sql<number>`count(*) filter (where status = 'COMPLETED')::int`,
    }).from(arisanPeriods);
    const [participantMetrics] = await db.select({
      activeParticipants: sql<number>`count(*) filter (where status = 'ACTIVE')::int`,
      allParticipants: sql<number>`count(*)::int`,
    }).from(arisanParticipants);
    const [financeMetrics] = await db.select({
      totalTopups: sql<string>`coalesce((select sum(amount) from topups where status = 'SUCCESS'), 0)::text`,
      totalWithdrawals: sql<string>`coalesce((select sum(amount) from withdrawals where status = 'SUCCESS'), 0)::text`,
      totalPayout: sql<string>`coalesce(sum(net_amount), 0)::text`,
    }).from(payouts);
    return jsonOk({
      users: userMetrics,
      wallets: walletMetrics,
      arisan: { ...periodMetrics, ...participantMetrics },
      finance: financeMetrics,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
