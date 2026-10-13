import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, complianceFlags, withdrawals, users } from "@/db/schema";
import { ApiError } from "@/server/http";

function financialWithdrawalView(withdrawal: {
  id: string; amount: number; status: string; approvalStatus: string; riskStatus: string;
  approvedBy?: string | null; approvedAt?: Date | null; approvalReason?: string | null; createdAt?: Date | null;
}) {
  return {
    id: withdrawal.id,
    amount: withdrawal.amount,
    status: withdrawal.status,
    approvalStatus: withdrawal.approvalStatus,
    riskStatus: withdrawal.riskStatus,
    approvedBy: withdrawal.approvedBy ?? null,
    approvedAt: withdrawal.approvedAt ?? null,
    approvalReason: withdrawal.approvalReason ?? null,
    createdAt: withdrawal.createdAt ?? null,
  };
}

const numberEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ApiError(`Konfigurasi ${name} tidak valid.`, "SERVER_CONFIGURATION_ERROR", 500);
  return value;
};

export async function assessWithdrawalRisk(tx: any, input: { userId: string; amount: number; withdrawalId: string }) {
  const singleLimit = numberEnv("COMPLIANCE_SINGLE_WITHDRAWAL_REVIEW_IDR", 10_000_000);
  const dailyLimit = numberEnv("COMPLIANCE_DAILY_WITHDRAWAL_REVIEW_IDR", 25_000_000);
  const hourlyCountLimit = numberEnv("COMPLIANCE_HOURLY_WITHDRAWAL_COUNT_REVIEW", 3);
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [velocity] = await tx.select({
    hourlyCount: sql<number>`count(*) filter (where ${withdrawals.createdAt} >= ${hourAgo})`,
    dailyAmount: sql<number>`coalesce(sum(${withdrawals.amount}) filter (where ${withdrawals.createdAt} >= ${dayAgo}), 0)`,
  }).from(withdrawals).where(eq(withdrawals.userId, input.userId));

  const flags: Array<{ code: string; score: number; reason: string; severity: string }> = [];
  if (input.amount >= singleLimit) flags.push({ code: "HIGH_SINGLE_WITHDRAWAL", score: 60, severity: "HIGH", reason: `Nominal withdrawal mencapai/melebihi threshold ${singleLimit} IDR.` });
  if (Number(velocity?.hourlyCount ?? 0) >= hourlyCountLimit) flags.push({ code: "WITHDRAWAL_VELOCITY", score: 30, severity: "MEDIUM", reason: `Frekuensi withdrawal mencapai ${hourlyCountLimit} transaksi dalam 1 jam.` });
  if (Number(velocity?.dailyAmount ?? 0) + input.amount >= dailyLimit) flags.push({ code: "DAILY_WITHDRAWAL_VOLUME", score: 40, severity: "HIGH", reason: `Akumulasi withdrawal 24 jam mencapai/melebihi ${dailyLimit} IDR.` });

  const score = flags.reduce((sum, item) => sum + item.score, 0);
  const riskStatus: "BLOCKED" | "REVIEW" | "CLEAR" =
  score >= 100
    ? "BLOCKED"
    : score > 0
      ? "REVIEW"
      : "CLEAR";
  for (const flag of flags) {
    await tx.insert(complianceFlags).values({ userId: input.userId, withdrawalId: input.withdrawalId, ruleCode: flag.code, severity: flag.severity, score: flag.score, reason: flag.reason });
  }
  return { riskStatus, riskScore: score, flags };
}

export async function requireKycVerified(userId: string) {
  const [user] = await db.select({ kycStatus: users.kycStatus }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError("Pengguna tidak ditemukan.", "USER_NOT_FOUND", 404);
  if (user.kycStatus !== "VERIFIED") throw new ApiError("KYC belum terverifikasi. Withdrawal belum dapat dilakukan.", "KYC_REQUIRED", 403);
}

export async function approveWithdrawal(input: { withdrawalId: string; adminId: string; reason?: string | null; ipAddress?: string | null; userAgent?: string | null }) {
  return db.transaction(async (tx) => {
    const [admin] = await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, input.adminId)).limit(1);
    if (!admin || admin.status !== "ACTIVE" || !["ADMIN", "SUPER_ADMIN"].includes(admin.role)) throw new ApiError("Akses administrator aktif diperlukan.", "FORBIDDEN", 403);
    await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${input.withdrawalId} FOR UPDATE`);
    const [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, input.withdrawalId)).limit(1);
    if (!withdrawal) throw new ApiError("Withdrawal tidak ditemukan.", "WITHDRAWAL_NOT_FOUND", 404);
    if (withdrawal.userId === input.adminId) throw new ApiError("Administrator tidak boleh meng-approve withdrawal miliknya sendiri.", "WITHDRAWAL_SELF_APPROVAL_BLOCKED", 403);
    if (withdrawal.approvalStatus === "APPROVED") return { withdrawal: financialWithdrawalView(withdrawal), replayed: true };
    if (withdrawal.status !== "PENDING" && withdrawal.status !== "FAILED_RETRYABLE") throw new ApiError("Withdrawal tidak berada pada state yang dapat di-approve.", "WITHDRAWAL_APPROVAL_INVALID", 409);
    if (withdrawal.riskStatus === "BLOCKED") throw new ApiError("Withdrawal diblokir oleh kontrol risiko.", "WITHDRAWAL_RISK_BLOCKED", 409);
    const [openFlags] = await tx.select({ count: sql<number>`count(*)` }).from(complianceFlags).where(and(eq(complianceFlags.withdrawalId, withdrawal.id), eq(complianceFlags.status, "OPEN")));
    if (Number(openFlags?.count ?? 0) > 0) throw new ApiError("Withdrawal masih memiliki compliance flag terbuka.", "COMPLIANCE_REVIEW_REQUIRED", 409);
    const [updated] = await tx.update(withdrawals).set({ approvalStatus: "APPROVED", approvedBy: input.adminId, approvedAt: new Date(), approvalReason: input.reason?.slice(0, 500) ?? null, updatedAt: new Date() }).where(eq(withdrawals.id, withdrawal.id)).returning();
    await tx.insert(auditLogs).values({ actorId: input.adminId, actorType: "ADMIN", action: "WITHDRAWAL_APPROVED", entityType: "withdrawal", entityId: withdrawal.id, oldValue: { approvalStatus: withdrawal.approvalStatus }, newValue: { approvalStatus: "APPROVED", riskStatus: withdrawal.riskStatus }, ipAddress: input.ipAddress ?? null, userAgent: input.userAgent ?? null });
    return { withdrawal: financialWithdrawalView(updated), replayed: false };
  });
}
