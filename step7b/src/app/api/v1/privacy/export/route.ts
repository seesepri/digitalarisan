import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import {
  notifications,
  privacyConsents,
  privacyRequests,
  users,
  walletTransactions,
  withdrawals,
} from "@/db/schema";
import { errorResponse, jsonOk, requireUser } from "@/server/http";

export async function GET(request: Request) {
  try {
    const user=await requireUser(request);

    const [profile] = await db
      .select({
        id: users.id,
        name:users.name,
        phone: users.phone,
        email:users.email,
        status: users.status,
        kycStatus: users.kycStatus,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, user.id));

    const [txs, ws, notificationsRows, consents, requests] =
      await Promise.all([
        db
          .select({
            id: walletTransactions.id,
            type: walletTransactions.type,
            direction: walletTransactions.direction,
            amount: walletTransactions.amount,
            status: walletTransactions.status,
            createdAt: walletTransactions.createdAt,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.userId,user.id))
          .orderBy(desc(walletTransactions.createdAt))
          .limit(500),

        db
          .select({
            id: withdrawals.id,
            amount: withdrawals.amount,
            status: withdrawals.status,
            approvalStatus: withdrawals.approvalStatus,
            riskStatus: withdrawals.riskStatus,
            createdAt: withdrawals.createdAt,
            updatedAt: withdrawals.updatedAt,
          })
          .from(withdrawals)
          .where(eq(withdrawals.userId,user.id))
          .orderBy(desc(withdrawals.createdAt))
          .limit(500),

        db
          .select({
            id: notifications.id,
            title: notifications.title,
            message: notifications.message,
            type: notifications.type,
            readAt: notifications.readAt,
            createdAt: notifications.createdAt,
          })
          .from(notifications)
          .where(eq(notifications.userId,user.id))
          .orderBy(desc(notifications.createdAt))
          .limit(500),

        db
          .select({
            policyType: privacyConsents.policyType,
            policyVersion: privacyConsents.policyVersion,
            granted: privacyConsents.granted,
            grantedAt: privacyConsents.grantedAt,
            withdrawnAt: privacyConsents.withdrawnAt,
            evidenceHash: privacyConsents.evidenceHash,
          })
          .from(privacyConsents)
          .where(eq(privacyConsents.userId,user.id))
          .orderBy(desc(privacyConsents.grantedAt))
          .limit(100),

        db
          .select({
            id: privacyRequests.id,
            type: privacyRequests.type,
            status: privacyRequests.status,
            reason: privacyRequests.reason,
            createdAt: privacyRequests.createdAt,
            processedAt: privacyRequests.processedAt,
          })
          .from(privacyRequests)
          .where(eq(privacyRequests.userId,user.id))
          .orderBy(desc(privacyRequests.createdAt))
          .limit(100),
      ]);

    return jsonOk({
      exportedAt: new Date().toISOString(),
      profile,
      walletTransactions: txs,
      withdrawals: ws,
      notifications: notificationsRows,
      privacyConsents: consents,
      privacyRequests: requests,
    });
  } catch (e) {
    return errorResponse(e);
  }
}