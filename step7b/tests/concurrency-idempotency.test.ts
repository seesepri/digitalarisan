import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

const { configureTestDatabase } = await import("../scripts/test-database-guard.mjs");
const testDbUrl = await configureTestDatabase();
const enabled = Boolean(testDbUrl);
if (enabled) process.env.PAYOUT_PROVIDER = "test";

let db: typeof import("@/db").db;
let pool: typeof import("@/db").pool;
let arisanParticipants: typeof import("@/db/schema").arisanParticipants;
let arisanPeriods: typeof import("@/db/schema").arisanPeriods;
let arisanTypes: typeof import("@/db/schema").arisanTypes;
let auditLogs: typeof import("@/db/schema").auditLogs;
let financialAccounts: typeof import("@/db/schema").financialAccounts;
let notifications: typeof import("@/db/schema").notifications;
let walletReservations: typeof import("@/db/schema").walletReservations;
let walletTransactions: typeof import("@/db/schema").walletTransactions;
let wallets: typeof import("@/db/schema").wallets;
let users: typeof import("@/db/schema").users;
let withdrawals: typeof import("@/db/schema").withdrawals;
let joinPeriod: typeof import("@/server/services/arisan").joinPeriod;
let cancelParticipation: typeof import("@/server/services/arisan").cancelParticipation;
let createWithdrawal: typeof import("@/server/services/wallet").createWithdrawal;
let processWithdrawal: typeof import("@/server/services/payout-withdrawal").processWithdrawal;
let approveWithdrawal: typeof import("@/server/services/compliance").approveWithdrawal;

if (enabled) {
  ({ db, pool } = await import("@/db"));
  ({ arisanParticipants, arisanPeriods, arisanTypes, auditLogs, financialAccounts, notifications, walletReservations, walletTransactions, wallets, users, withdrawals } = await import("@/db/schema"));
  ({ joinPeriod, cancelParticipation } = await import("@/server/services/arisan"));
  ({ createWithdrawal } = await import("@/server/services/wallet"));
  ({ processWithdrawal } = await import("@/server/services/payout-withdrawal"));
  ({ approveWithdrawal } = await import("@/server/services/compliance"));
}

function evidence(id: string, amount: number, status: "SUCCESS" | "FAILED_RETRYABLE") {
  return { provider: "test", reference: `WD-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`, providerReference: `PROV-${id}`, amount, currency: "IDR" as const, status, failureConfirmed: status === "FAILED_RETRYABLE", checkedAt: new Date().toISOString() };
}

const maybeDescribe = enabled ? describe : describe.skip;
const createdUsers: string[] = [];
const createdPeriods: string[] = [];
const createdTypes: string[] = [];
const createdWallets: string[] = [];

async function createUserWithWallet(balance = 100_000) {
  const userId = randomUUID();
  const walletId = randomUUID();
  const suffix = randomUUID().slice(0, 12);
  await db.insert(users).values({
    id: userId,
    name: `Concurrency Test ${suffix}`,
    phone: `08${Date.now()}${Math.floor(Math.random() * 100000)}`.slice(0, 24),
    email: `concurrency-${suffix}@test.invalid`,
    passwordHash: "test-only",
    role: "USER",
    status: "ACTIVE",
    kycStatus: "VERIFIED",
    kycReviewedBy: userId,
  });
  await db.insert(wallets).values({ id: walletId, userId, availableBalance: balance });
  createdUsers.push(userId);
  createdWallets.push(walletId);
  return { userId, walletId };
}

async function createAdminUser() {
  const userId = randomUUID();
  const suffix = randomUUID().slice(0, 12);

  await db.insert(users).values({
    id: userId,
    name: `Concurrency Admin ${suffix}`,
    phone: `09${Date.now()}${Math.floor(Math.random() * 100000)}`.slice(0, 24),
    email: `concurrency-admin-${suffix}@test.invalid`,
    passwordHash: "test-only",
    role: "ADMIN",
    status: "ACTIVE",
    kycStatus: "VERIFIED",
    kycReviewedBy: userId,
  });

  createdUsers.push(userId);
  return { userId };
}

async function createOpenPeriod(maximumParticipants: number, contributionAmount = 10_000) {
  const typeId = randomUUID();
  const periodId = randomUUID();
  const now = Date.now();
  await db.insert(arisanTypes).values({
    id: typeId,
    name: `Concurrency Test ${typeId.slice(0, 8)}`,
    description: "test",
    contributionAmount,
    minimumParticipants: 2,
    maximumParticipants,
    cancellationDeadlineDays: 0,
    platformFeeBps: 0,
    active: true,
  });
  await db.insert(arisanPeriods).values({
    id: periodId,
    typeId,
    code: `TEST-${periodId.slice(0, 12)}`,
    registrationStartsAt: new Date(now - 60_000),
    registrationEndsAt: new Date(now + 60 * 60_000),
    drawingAt: new Date(now + 2 * 60 * 60_000),
    cancellationDeadlineAt: new Date(now + 30 * 60_000),
    minimumParticipants: 2,
    maximumParticipants,
    contributionAmount,
    platformFeeBps: 0,
    status: "OPEN",
  });
  createdTypes.push(typeId);
  createdPeriods.push(periodId);
  return periodId;
}

async function cleanup() {
  if (!testDbUrl) return;

  const userIds = [...createdUsers];
  const periodIds = [...createdPeriods];
  const typeIds = [...createdTypes];

  // Notifications are ephemeral and may be cleaned after the test.
  if (userIds.length) {
    await db.delete(notifications)
      .where(inArray(notifications.userId, userIds));
  }

  // Financial accounts, wallet reservations, withdrawals, wallet
  // transactions, and other financial history are retained.
  // Participants are retained because wallet_reservations may reference
  // them and financial history must not be destructively deleted.
  // Periods/types are retained for the same historical-reference safety.

  // Test users are anonymized instead of deleted because retained
  // financial history references them through foreign keys.
  if (userIds.length) {
    for (const userId of userIds) {
      const erasedSuffix = userId.replace(/-/g, "").slice(0, 12);

      await db.update(users).set({
        name: `Erased Test User ${erasedSuffix}`,
        phone: `08ERASED${erasedSuffix}`.slice(0, 24),
        email: `erased-${erasedSuffix}@test.invalid`,
        passwordHash: "ERASED",
        avatarUrl: null,
        status: "SUSPENDED",
        phoneVerifiedAt: null,
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycReviewedAt: null,
        kycReviewedBy: null,
        kycRejectionReason: null,
        updatedAt: new Date(),
      }).where(eq(users.id, userId));
    }
  }
}
before(async () => {
  if (!enabled) return;
  await pool.query("SELECT 1");
});

after(async () => {
  if (!enabled) return;
  await cleanup();
  await pool.end();
});

maybeDescribe("concurrency + idempotency", () => {
  test("concurrent joins never exceed period capacity", async () => {
    const periodId = await createOpenPeriod(5, 10_000);
    const usersForJoin = await Promise.all(Array.from({ length: 20 }, () => createUserWithWallet(20_000)));
    const results = await Promise.allSettled(
      usersForJoin.map((user) => joinPeriod({ periodId, userId: user.userId, idempotencyKey: `join-${user.userId}` })),
    );
    const success = results.filter((r) => r.status === "fulfilled");
    assert.equal(success.length, 5);
    const [count] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(arisanParticipants)
      .where(and(eq(arisanParticipants.periodId, periodId), eq(arisanParticipants.status, "ACTIVE")));
    assert.equal(Number(count.count), 5);
    const [locked] = await db
      .select({ total: sql<number>`COALESCE(SUM(${wallets.lockedBalance}), 0)` })
      .from(wallets)
      .where(inArray(wallets.id, usersForJoin.map((u) => u.walletId)));
    assert.equal(Number(locked.total), 50_000);
  });

  test("duplicate join requests with the same idempotency key create one participant", async () => {
    const periodId = await createOpenPeriod(2, 10_000);
    const user = await createUserWithWallet(20_000);
    const key = `duplicate-join-${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => joinPeriod({ periodId, userId: user.userId, idempotencyKey: key })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 25);
    const participants = await db.select().from(arisanParticipants).where(and(eq(arisanParticipants.periodId, periodId), eq(arisanParticipants.userId, user.userId)));
    assert.equal(participants.length, 1);
    const txs = await db.select().from(walletTransactions).where(and(eq(walletTransactions.userId, user.userId), eq(walletTransactions.idempotencyKey, key)));
    assert.equal(txs.length, 1);
  });

  test("concurrent withdrawals cannot overspend available balance", async () => {
    const user = await createUserWithWallet(100_000);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        createWithdrawal({
          userId: user.userId,
          amount: 10_000,
          bankName: "TEST BANK",
          accountName: "Concurrency Test",
          accountNumber: String(1234567890 + index),
          idempotencyKey: `withdraw-${user.userId}-${index}`,
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, user.walletId));
    assert.equal(wallet.availableBalance, 0);
    assert.equal(wallet.pendingBalance, 100_000);
    const created = await db.select().from(withdrawals).where(eq(withdrawals.userId, user.userId));
    assert.equal(created.length, 10);
  });

  test("duplicate withdrawal requests return the same withdrawal and reserve funds once", async () => {
    const user = await createUserWithWallet(100_000);
    const key = `duplicate-withdraw-${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        createWithdrawal({
          userId: user.userId,
          amount: 25_000,
          bankName: "TEST BANK",
          accountName: "Concurrency Test",
          accountNumber: "1234567890",
          idempotencyKey: key,
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 25);
    const withdrawalsForUser = await db.select().from(withdrawals).where(eq(withdrawals.userId, user.userId));
    assert.equal(withdrawalsForUser.length, 1);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, user.walletId));
    assert.equal(wallet.availableBalance, 75_000);
    assert.equal(wallet.pendingBalance, 25_000);
  });


  test("concurrent duplicate withdrawal completion is idempotent", async () => {
    const user = await createUserWithWallet(100_000);
    const maker = await createAdminUser();
    const checker = await createAdminUser();
    const created = await createWithdrawal({
      userId: user.userId, amount: 25_000, bankName: "TEST BANK", accountName: "Concurrency Test",
      accountNumber: "1234567890", idempotencyKey: `withdraw-process-${randomUUID()}`,
    });
    await approveWithdrawal({ withdrawalId: created.withdrawal.id, adminId: maker.userId, reason: "Concurrency test approval" });
    await processWithdrawal({ withdrawalId: created.withdrawal.id, decision: "PROCESSING", adminId: checker.userId, adminRole: "ADMIN" });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
      processWithdrawal({ withdrawalId: created.withdrawal.id, decision: "SUCCESS", adminId: checker.userId, adminRole: "ADMIN", source: "PROVIDER", providerEvidence: evidence(created.withdrawal.id, 25_000, "SUCCESS"), expectedAttemptCount: 1 }),
    ));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 20);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, user.walletId));
    assert.equal(wallet.availableBalance, 75_000);
    assert.equal(wallet.pendingBalance, 0);
    const txs = await db.select().from(walletTransactions).where(eq(walletTransactions.userId, user.userId)).orderBy(walletTransactions.ledgerSequence);
    const withdrawalTxs = txs.filter((tx) => tx.referenceType === "withdrawal" && tx.referenceId === created.withdrawal.id);
    assert.equal(withdrawalTxs.length, 2);
    assert.equal(withdrawalTxs[0].pendingBefore, 0);
    assert.equal(withdrawalTxs[0].pendingAfter, 25_000);
    assert.equal(withdrawalTxs[1].pendingBefore, 25_000);
    assert.equal(withdrawalTxs[1].pendingAfter, 0);
    assert.equal(withdrawalTxs[1].availableBefore, 75_000);
    assert.equal(withdrawalTxs[1].availableAfter, 75_000);
  });

  test("admin cannot finalize withdrawal without provider confirmation", async () => {
    const user = await createUserWithWallet(50_000);
    const maker = await createAdminUser();
    const checker = await createAdminUser();
    const created = await createWithdrawal({
      userId: user.userId, amount: 25_000, bankName: "TEST BANK", accountName: "Authority Test",
      accountNumber: "1234567890", idempotencyKey: `withdraw-authority-${randomUUID()}`,
    });
    await approveWithdrawal({ withdrawalId: created.withdrawal.id, adminId: maker.userId, reason: "Authority test approval" });
    await processWithdrawal({ withdrawalId: created.withdrawal.id, decision: "PROCESSING", adminId: checker.userId, adminRole: "ADMIN" });
    await assert.rejects(
      () => processWithdrawal({ withdrawalId: created.withdrawal.id, decision: "SUCCESS", adminId: user.userId, adminRole: "ADMIN" }),
      /SUCCESS\/FAILED hanya dapat ditetapkan berdasarkan konfirmasi payout provider/,
    );
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, user.walletId));
    const [withdrawal] = await db.select().from(withdrawals).where(eq(withdrawals.id, created.withdrawal.id));
    assert.equal(withdrawal.status, "PROCESSING");
    assert.equal(wallet.availableBalance, 25_000);
    assert.equal(wallet.pendingBalance, 25_000);
  });

  test("five explicitly confirmed failed transfers release funds once with consistent final metadata", async () => {
    const user = await createUserWithWallet(100_000);
    const maker = await createAdminUser();
    const checker = await createAdminUser();
    const created = await createWithdrawal({
      userId: user.userId, amount: 25_000, bankName: "TEST BANK", accountName: "Concurrency Test",
      accountNumber: "1234567890", idempotencyKey: `withdraw-retry-${randomUUID()}`,
    });
    await approveWithdrawal({ withdrawalId: created.withdrawal.id, adminId: maker.userId, reason: "Retry test approval" });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await processWithdrawal({ withdrawalId: created.withdrawal.id, decision: "PROCESSING", adminId: checker.userId, adminRole: "ADMIN" });
      await processWithdrawal({ withdrawalId: created.withdrawal.id, decision: "FAILED_RETRYABLE", adminId: user.userId, adminRole: "ADMIN", source: "PROVIDER", providerEvidence: evidence(created.withdrawal.id, 25_000, "FAILED_RETRYABLE"), expectedAttemptCount: attempt });
      if (attempt < 5) {
        await db.update(withdrawals).set({ nextRetryAt: new Date(Date.now() - 1_000) }).where(eq(withdrawals.id, created.withdrawal.id));
      }
    }
    const [withdrawal] = await db.select().from(withdrawals).where(eq(withdrawals.id, created.withdrawal.id));
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, user.walletId));
    assert.equal(withdrawal.status, "FAILED_FINAL");
    assert.equal(wallet.pendingBalance, 0);
    assert.equal(wallet.availableBalance, 100_000);
    assert.equal(withdrawal.lastErrorCode, "PROVIDER_RETRIES_EXHAUSTED");
    assert.equal(withdrawal.nextRetryAt, null);
    assert.doesNotMatch(withdrawal.lastErrorMessage ?? "", /dana tetap ditahan/);
  });

  test("two different cancellation keys cannot refund the same participant twice", async () => {
    const periodId = await createOpenPeriod(2, 10_000);
    const user = await createUserWithWallet(20_000);
    const joined = await joinPeriod({ periodId, userId: user.userId, idempotencyKey: `join-cancel-${randomUUID()}` });
    const participantId = joined.participantId;

    assert.ok(participantId, "participantId must exist before cancellation");

    const results = await Promise.allSettled([
    cancelParticipation({
    participantId,
    userId: user.userId,
    idempotencyKey: `cancel-a-${randomUUID()}`
  }),
  cancelParticipation({
    participantId,
    userId: user.userId,
    idempotencyKey: `cancel-b-${randomUUID()}`
  }),
]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const [wallet] = await db.select().from(wallets).where(eq(wallets.id, user.walletId));
    assert.equal(wallet.availableBalance, 20_000);
    assert.equal(wallet.lockedBalance, 0);
    const cancels = await db.select().from(walletTransactions).where(and(eq(walletTransactions.userId, user.userId), eq(walletTransactions.type, "CANCEL_ARISAN")));
    assert.equal(cancels.length, 1);
  });
});















