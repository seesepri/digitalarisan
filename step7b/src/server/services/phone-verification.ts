import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, phoneVerificationChallenges, userSessions, users, wallets } from "@/db/schema";
import { createRefreshToken, hashPassword, hashToken, refreshTokenMaxAge } from "@/server/auth";
import { ApiError } from "@/server/http";
import { checkVerificationSms, sendVerificationSms } from "@/server/services/sms-provider";

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_VERIFICATION_ATTEMPTS = 5;
const VERIFY_LOCK_MS = 60_000;

export type PhoneVerificationPurpose = "SIGNUP" | "LOGIN_VERIFY" | "PASSWORD_RESET";
type StartInput = { phone: string; purpose: PhoneVerificationPurpose; userId?: string };

export async function startPhoneVerification(input: StartInput) {
  const now = new Date();
  const [challenge] = await db.insert(phoneVerificationChallenges).values({
    phone: input.phone,
    purpose: input.purpose,
    userId: input.userId ?? null,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    verificationAttempts: 0,
    verificationToken: null,
    verificationStartedAt: null,
    lastSentAt: now,
  }).onConflictDoUpdate({
    target: phoneVerificationChallenges.phone,
    set: {
      id: randomUUID(),
      purpose: input.purpose,
      userId: input.userId ?? null,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      verificationAttempts: 0,
      verificationToken: null,
      verificationStartedAt: null,
      lastSentAt: now,
    },
  }).returning({ id: phoneVerificationChallenges.id });

  try {
    await sendVerificationSms(input.phone, input.purpose);
  } catch (error) {
    await db.delete(phoneVerificationChallenges).where(eq(phoneVerificationChallenges.id, challenge.id));
    throw error;
  }
  return { expiresInSeconds: Math.floor(CHALLENGE_TTL_MS / 1000) };
}

async function claimAndCheckPhoneCode(input: { phone: string; code: string; purpose: PhoneVerificationPurpose }) {
  const verificationToken = randomUUID();
  const now = new Date();
  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM phone_verification_challenges WHERE phone = ${input.phone} FOR UPDATE`);
    const [challenge] = await tx.select().from(phoneVerificationChallenges).where(eq(phoneVerificationChallenges.phone, input.phone)).limit(1);
    if (!challenge || challenge.expiresAt <= now || challenge.purpose !== input.purpose) {
      if (challenge && challenge.expiresAt <= now) await tx.delete(phoneVerificationChallenges).where(eq(phoneVerificationChallenges.id, challenge.id));
      throw new ApiError("Kode verifikasi tidak valid atau sudah kedaluwarsa.", "PHONE_VERIFICATION_INVALID", 400);
    }
    if (challenge.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      throw new ApiError("Batas percobaan kode tercapai. Minta kode baru.", "PHONE_VERIFICATION_ATTEMPTS_EXCEEDED", 429);
    }
    if (challenge.verificationToken && challenge.verificationStartedAt && now.getTime() - challenge.verificationStartedAt.getTime() < VERIFY_LOCK_MS) {
      throw new ApiError("Verifikasi sedang diproses. Coba kembali sebentar lagi.", "PHONE_VERIFICATION_IN_PROGRESS", 409);
    }
    await tx.update(phoneVerificationChallenges).set({
      verificationToken,
      verificationStartedAt: now,
      verificationAttempts: challenge.verificationAttempts + 1,
    }).where(eq(phoneVerificationChallenges.id, challenge.id));
    return { id: challenge.id, userId: challenge.userId, verificationToken };
  });

  let approved: boolean;
  try {
    approved = await checkVerificationSms(input.phone, input.code, input.purpose);
  } catch (error) {
    await db.update(phoneVerificationChallenges).set({ verificationToken: null, verificationStartedAt: null })
      .where(and(eq(phoneVerificationChallenges.id, claim.id), eq(phoneVerificationChallenges.verificationToken, verificationToken)));
    throw error;
  }
  if (!approved) {
    await db.update(phoneVerificationChallenges).set({ verificationToken: null, verificationStartedAt: null })
      .where(and(eq(phoneVerificationChallenges.id, claim.id), eq(phoneVerificationChallenges.verificationToken, verificationToken)));
    throw new ApiError("Kode verifikasi tidak valid atau sudah kedaluwarsa.", "PHONE_VERIFICATION_INVALID", 400);
  }
  return claim;
}

export async function verifyPhoneAndCreateSession(input: { phone: string; code: string; purpose: "SIGNUP" | "LOGIN_VERIFY"; registration?: { name: string; password: string }; meta?: { ipAddress?: string | null; userAgent?: string | null } }) {
  const claim = await claimAndCheckPhoneCode(input);

  if (input.purpose === "SIGNUP" && claim.userId) {
    await db.update(phoneVerificationChallenges).set({ verificationToken: null, verificationStartedAt: null })
      .where(and(eq(phoneVerificationChallenges.id, claim.id), eq(phoneVerificationChallenges.verificationToken, claim.verificationToken)));
    throw new ApiError("Kode verifikasi tidak valid atau sudah kedaluwarsa.", "PHONE_VERIFICATION_INVALID", 400);
  }
  if (input.purpose === "LOGIN_VERIFY" && !claim.userId) {
    await db.update(phoneVerificationChallenges).set({ verificationToken: null, verificationStartedAt: null })
      .where(and(eq(phoneVerificationChallenges.id, claim.id), eq(phoneVerificationChallenges.verificationToken, claim.verificationToken)));
    throw new ApiError("Kode verifikasi tidak valid atau sudah kedaluwarsa.", "PHONE_VERIFICATION_INVALID", 400);
  }
  if (input.purpose === "SIGNUP" && !input.registration) {
    await db.update(phoneVerificationChallenges).set({ verificationToken: null, verificationStartedAt: null })
      .where(and(eq(phoneVerificationChallenges.id, claim.id), eq(phoneVerificationChallenges.verificationToken, claim.verificationToken)));
    throw new ApiError("Nama dan password diperlukan setelah verifikasi nomor HP.", "REGISTRATION_DETAILS_REQUIRED", 400);
  }
  const registrationPasswordHash = input.registration ? await hashPassword(input.registration.password) : null;

  const refreshToken = createRefreshToken();
  const expiresAt = new Date(Date.now() + refreshTokenMaxAge * 1000);
  const completed = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM phone_verification_challenges WHERE id = ${claim.id} FOR UPDATE`);
    const [challenge] = await tx.select().from(phoneVerificationChallenges)
      .where(and(eq(phoneVerificationChallenges.id, claim.id), eq(phoneVerificationChallenges.verificationToken, claim.verificationToken))).limit(1);
    if (!challenge || challenge.expiresAt <= new Date() || challenge.purpose !== input.purpose) {
      throw new ApiError("Kode verifikasi tidak valid atau sudah kedaluwarsa.", "PHONE_VERIFICATION_INVALID", 400);
    }

    let user: { id: string; name: string; phone: string; email: string | null; role: "USER" | "ADMIN" | "SUPER_ADMIN"; status: "ACTIVE" | "SUSPENDED" | "PENDING" };
    if (input.purpose === "LOGIN_VERIFY" && challenge.userId) {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${challenge.userId} FOR UPDATE`);
      const [existing] = await tx.select().from(users).where(eq(users.id, challenge.userId)).limit(1);
      if (!existing || existing.phone !== input.phone) throw new ApiError("Akun verifikasi tidak ditemukan.", "PHONE_VERIFICATION_INVALID", 400);
      const [updated] = await tx.update(users).set({ phoneVerifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, existing.id)).returning({ id: users.id, name: users.name, phone: users.phone, email: users.email, role: users.role, status: users.status });
      user = updated;
    } else if (input.purpose === "SIGNUP" && !challenge.userId) {
      if (!input.registration || !registrationPasswordHash) throw new ApiError("Data pendaftaran tidak lengkap.", "PHONE_VERIFICATION_INVALID", 400);
      const [created] = await tx.insert(users).values({
        name: input.registration.name,
        phone: input.phone,
        email: null,
        passwordHash: registrationPasswordHash,
        status: "ACTIVE",
        role: "USER",
        phoneVerifiedAt: new Date(),
      }).returning({ id: users.id, name: users.name, phone: users.phone, email: users.email, role: users.role, status: users.status });
      await tx.insert(wallets).values({ userId: created.id });
      user = created;
      await tx.insert(auditLogs).values({ actorId: user.id, actorType: "USER", action: "USER_REGISTERED_PHONE_VERIFIED", entityType: "user", entityId: user.id, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
    } else {
      throw new ApiError("Kode verifikasi tidak sesuai dengan proses.", "PHONE_VERIFICATION_INVALID", 400);
    }

    if (user.status === "ACTIVE") {
      const [session] = await tx.insert(userSessions).values({
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt,
        ipAddress: input.meta?.ipAddress ?? null,
        userAgent: input.meta?.userAgent ?? null,
      }).returning({ id: userSessions.id });
      await tx.insert(auditLogs).values({ actorId: user.id, actorType: "USER", action: "PHONE_VERIFICATION_COMPLETED", entityType: "user_session", entityId: session.id, ipAddress: input.meta?.ipAddress ?? null, userAgent: input.meta?.userAgent ?? null });
      await tx.delete(phoneVerificationChallenges).where(eq(phoneVerificationChallenges.id, challenge.id));
      return { user, sessionId: session.id, active: true as const };
    }

    await tx.delete(phoneVerificationChallenges).where(eq(phoneVerificationChallenges.id, challenge.id));
    return { user, sessionId: null, active: false as const };
  });

  if (!completed.active || !completed.sessionId) {
    throw new ApiError("Akun sedang tidak aktif. Hubungi dukungan.", "ACCOUNT_INACTIVE", 403);
  }
  return { user: completed.user, sessionId: completed.sessionId, refreshToken };
}

export async function startPasswordReset(phone: string): Promise<void> {
  const [user] = await db.select({ id: users.id, phoneVerifiedAt: users.phoneVerifiedAt })
    .from(users).where(eq(users.phone, phone)).limit(1);
  // Do not reveal whether the account or its verified phone exists to the caller.
  if (!user || !user.phoneVerifiedAt) return;
  try {
    await startPhoneVerification({ phone, userId: user.id, purpose: "PASSWORD_RESET" });
  } catch {
    // Keep the reset-request response identical for nonexistent numbers and SMS/provider failures.
  }
}

export async function resetPasswordWithPhoneCode(input: {
  phone: string;
  code: string;
  newPassword: string;
  meta?: { ipAddress?: string | null; userAgent?: string | null };
}): Promise<void> {
  const claim = await claimAndCheckPhoneCode({ phone: input.phone, code: input.code, purpose: "PASSWORD_RESET" });
  if (!claim.userId) {
    await db.delete(phoneVerificationChallenges).where(and(eq(phoneVerificationChallenges.id, claim.id), eq(phoneVerificationChallenges.verificationToken, claim.verificationToken)));
    throw new ApiError("Kode verifikasi tidak valid atau sudah kedaluwarsa.", "PHONE_VERIFICATION_INVALID", 400);
  }
  const resetUserId = claim.userId;
  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM phone_verification_challenges WHERE id = ${claim.id} FOR UPDATE`);
    const [challenge] = await tx.select().from(phoneVerificationChallenges)
      .where(and(
        eq(phoneVerificationChallenges.id, claim.id),
        eq(phoneVerificationChallenges.verificationToken, claim.verificationToken),
        eq(phoneVerificationChallenges.purpose, "PASSWORD_RESET"),
        eq(phoneVerificationChallenges.userId, resetUserId),
      )).limit(1);
    if (!challenge || challenge.expiresAt <= new Date()) {
      throw new ApiError("Kode verifikasi tidak valid atau sudah kedaluwarsa.", "PHONE_VERIFICATION_INVALID", 400);
    }

    await tx.execute(sql`SELECT id FROM users WHERE id = ${claim.userId} FOR UPDATE`);
    const [user] = await tx.select({ id: users.id, phone: users.phone, phoneVerifiedAt: users.phoneVerifiedAt })
      .from(users).where(eq(users.id, resetUserId)).limit(1);
    if (!user || user.phone !== input.phone || !user.phoneVerifiedAt) {
      throw new ApiError("Kode verifikasi tidak valid atau sudah kedaluwarsa.", "PHONE_VERIFICATION_INVALID", 400);
    }

    const now = new Date();
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, user.id));
    const revokedSessions = await tx.update(userSessions).set({ revokedAt: now })
      .where(and(eq(userSessions.userId, user.id), sql`${userSessions.revokedAt} IS NULL`))
      .returning({ id: userSessions.id });
    await tx.insert(auditLogs).values({
      actorId: user.id,
      actorType: "USER",
      action: "PASSWORD_RESET_BY_VERIFIED_PHONE",
      entityType: "user",
      entityId: user.id,
      oldValue: { activeSessionsRevoked: revokedSessions.length },
      ipAddress: input.meta?.ipAddress ?? null,
      userAgent: input.meta?.userAgent ?? null,
    });
    await tx.delete(phoneVerificationChallenges).where(eq(phoneVerificationChallenges.id, challenge.id));
  });
}
