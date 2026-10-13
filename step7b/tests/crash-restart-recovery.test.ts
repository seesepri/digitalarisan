import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";

const { configureTestDatabase } = await import("../scripts/test-database-guard.mjs");
const testDbUrl = await configureTestDatabase();
const enabled = Boolean(testDbUrl);

let db: typeof import("@/db").db;
let pool: typeof import("@/db").pool;
let schema: typeof import("@/db/schema");
let createWithdrawal: typeof import("@/server/services/wallet").createWithdrawal;
let executeWithdrawal: typeof import("@/server/services/payout-withdrawal").executeWithdrawal;
let stablePayoutReference: typeof import("@/server/services/payout-provider").stablePayoutReference;

if (enabled) {
  ({ db, pool } = await import("@/db"));
  schema = await import("@/db/schema");
  ({ createWithdrawal } = await import("@/server/services/wallet"));
  ({ executeWithdrawal } = await import("@/server/services/payout-withdrawal"));
  ({ stablePayoutReference } = await import("@/server/services/payout-provider"));
}

const maybeDescribe = enabled ? describe : describe.skip;
beforeEach(() => { providerCreateCount = 0; providerStatusCount = 0; providerReferences.clear(); });
const createdUsers: string[] = [];
const createdWallets: string[] = [];
const createdWithdrawalIds: string[] = [];
const createdPeriodIds: string[] = [];
const createdTypeIds: string[] = [];
const createdParticipantIds: string[] = [];

async function createUserWithWallet(balance = 100_000, role: "USER" | "ADMIN" = "USER") {
  const userId = randomUUID();
  const walletId = randomUUID();
  const suffix = randomUUID().slice(0, 12);
  await db.insert(schema.users).values({
    id: userId,
    name: `Crash Recovery ${suffix}`,
    phone: `08${Date.now()}${Math.floor(Math.random() * 100000)}`.slice(0, 24),
    email: `crash-${suffix}@test.invalid`,
    passwordHash: "test-only",
    role,
    status: "ACTIVE",
    kycStatus: "VERIFIED",
    kycVerifiedAt: new Date(),
    kycReviewedBy: userId,
  });
  await db.insert(schema.wallets).values({ id: walletId, userId, availableBalance: balance });
  createdUsers.push(userId);
  createdWallets.push(walletId);
  return { userId, walletId };
}

async function approveWithdrawal(withdrawalId: string, checkerId: string) {
  await db.update(schema.withdrawals).set({
    approvalStatus: "APPROVED",
    approvedBy: checkerId,
    approvedAt: new Date(),
    riskStatus: "CLEAR",
    updatedAt: new Date(),
  }).where(eq(schema.withdrawals.id, withdrawalId));
}

let providerServer: Server | null = null;
let providerBaseUrl = "";
let providerCreateCount = 0;
let providerStatusCount = 0;
const providerReferences = new Map<string, number>();

async function startFakePayoutProvider() {
  providerCreateCount = 0;
  providerStatusCount = 0;
  providerReferences.clear();

  providerServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const reference = req.headers["idempotency-key"]?.toString() || body.reference;

    if (req.method === "POST" && req.url === "/disbursements") {
      if (!providerReferences.has(reference)) { providerCreateCount += 1; providerReferences.set(reference, body.amount); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reference, providerReference: `PROV-${reference}`, amount: providerReferences.get(reference), currency: "IDR", status: "SUCCESS" }));
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/disbursements/")) {
      providerStatusCount += 1;
      const urlReference = decodeURIComponent(req.url.slice("/disbursements/".length));
      assert.ok(providerReferences.has(urlReference), `provider status requested for unknown reference ${urlReference}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reference: urlReference, providerReference: `PROV-${urlReference}`, amount: providerReferences.get(urlReference), currency: "IDR", status: "SUCCESS" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    providerServer!.once("error", reject);
    providerServer!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = providerServer.address();
  if (!address || typeof address === "string") throw new Error("Fake provider address unavailable");
  providerBaseUrl = `http://127.0.0.1:${address.port}`;
  process.env.PAYOUT_PROVIDER = `crash-recovery-${address.port}`;
  process.env.PAYOUT_PROVIDER_BASE_URL = providerBaseUrl;
  process.env.PAYOUT_PROVIDER_API_KEY = "test-key";
  process.env.PAYOUT_PROVIDER_CREATE_PATH = "/disbursements";
  process.env.PAYOUT_PROVIDER_STATUS_PATH = "/disbursements/{reference}";
  process.env.PROVIDER_TIMEOUT_MS = "3000";
}

async function stopFakePayoutProvider() {
  if (!providerServer) return;
  await new Promise<void>((resolve, reject) => providerServer!.close((error) => error ? reject(error) : resolve()));
  providerServer = null;
}

async function cleanup() {
  if (!testDbUrl) return;

  if (createdUsers.length) {
    await db.delete(schema.notifications)
      .where(inArray(schema.notifications.userId, createdUsers));
  }

  // Financial, ledger, audit, wallet, and user history are retained.
  // Test users are anonymized instead of deleted.
  if (createdUsers.length) {
    for (const userId of createdUsers) {
      const suffix = userId.replace(/-/g, "").slice(0, 12);

      await db.update(schema.users)
        .set({
          name: `Erased Test User ${suffix}`,
          phone: `08ERASED${suffix}`.slice(0, 24),
          email: `erased-${suffix}@test.invalid`,
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
        })
        .where(eq(schema.users.id, userId));
    }
  }

  if (createdParticipantIds.length) {
    await db.delete(schema.arisanParticipants)
      .where(inArray(schema.arisanParticipants.id, createdParticipantIds));
  }

  if (createdPeriodIds.length) {
    await db.delete(schema.arisanPeriods)
      .where(inArray(schema.arisanPeriods.id, createdPeriodIds));
  }

  if (createdTypeIds.length) {
    await db.delete(schema.arisanTypes)
      .where(inArray(schema.arisanTypes.id, createdTypeIds));
  }
}
before(async () => {
  if (!enabled) return;
  await pool.query("SELECT 1");
  await startFakePayoutProvider();
});

after(async () => {
  if (!enabled) return;
  await stopFakePayoutProvider();
  await cleanup();
  await pool.end();
});

maybeDescribe("crash/restart recovery", () => {
  test("crash after wallet lock rolls back the transaction; retry creates exactly one debit/reservation", async () => {
    const user = await createUserWithWallet(100_000);
    const idempotencyKey = `CRASH-LOCK-${randomUUID()}`;

    await assert.rejects(
      () => db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM wallets WHERE id = ${user.walletId} FOR UPDATE`);
        throw new Error("SIMULATED_SERVER_CRASH_AFTER_WALLET_LOCK");
      }),
      /SIMULATED_SERVER_CRASH_AFTER_WALLET_LOCK/,
    );

    const [afterCrash] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, user.walletId));
    assert.equal(afterCrash.availableBalance, 100_000);
    assert.equal(afterCrash.pendingBalance, 0);

    const created = await createWithdrawal({
      userId: user.userId,
      amount: 25_000,
      bankName: "TEST BANK",
      accountName: "Crash Recovery",
      accountNumber: "1234567890",
      idempotencyKey,
    });
    createdWithdrawalIds.push(created.withdrawal.id);

    const replay = await createWithdrawal({
      userId: user.userId,
      amount: 25_000,
      bankName: "TEST BANK",
      accountName: "Crash Recovery",
      accountNumber: "1234567890",
      idempotencyKey,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.withdrawal.id, created.withdrawal.id);

    const [wallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, user.walletId));
    assert.equal(wallet.availableBalance, 75_000);
    assert.equal(wallet.pendingBalance, 25_000);
    assert.equal((await db.select().from(schema.withdrawals).where(eq(schema.withdrawals.id, created.withdrawal.id))).length, 1);
    assert.equal((await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.idempotencyKey, idempotencyKey))).length, 1);
  });

  test("provider SUCCESS followed by simulated process death finalizes exactly once after restart", async () => {
    const user = await createUserWithWallet(100_000);
    const maker = await createUserWithWallet(0, "ADMIN");
    const admin = await createUserWithWallet(0, "ADMIN");
    const created = await createWithdrawal({
      userId: user.userId,
      amount: 30_000,
      bankName: "TEST BANK",
      accountName: "Crash Recovery",
      accountNumber: "1234567890",
      idempotencyKey: `CRASH-PROVIDER-${randomUUID()}`,
    });
    createdWithdrawalIds.push(created.withdrawal.id);
    await approveWithdrawal(created.withdrawal.id, maker.userId);

    const { processWithdrawal } = await import("@/server/services/payout-withdrawal");
    await processWithdrawal({ withdrawalId: created.withdrawal.id, decision: "PROCESSING", adminId: admin.userId, adminRole: "ADMIN" });
    const reference = stablePayoutReference(created.withdrawal.id);
    const { HttpPayoutProvider } = await import("@/server/services/payout-provider");
    const provider = new HttpPayoutProvider(process.env.PAYOUT_PROVIDER!);
    const providerResult = await provider.createDisbursement({
      reference,
      bankName: created.withdrawal.bankName,
      accountName: created.withdrawal.accountName,
      accountNumber: created.withdrawal.accountNumber,
      amount: created.withdrawal.amount,
    });
    assert.equal(providerResult.status, "SUCCESS");
    assert.equal(providerCreateCount, 1);

    // Simulated process death: provider has committed SUCCESS, but the local
    // process dies before processWithdrawal() can commit the local accounting.
    // Restart is represented by a fresh executeWithdrawal() call.
    const [beforeRestart] = await db.select().from(schema.withdrawals).where(eq(schema.withdrawals.id, created.withdrawal.id));
    assert.equal(beforeRestart.status, "PROCESSING");
    const [walletBeforeRestart] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, user.walletId));
    assert.equal(walletBeforeRestart.pendingBalance, 30_000);

    const recovered = await executeWithdrawal({ withdrawalId: created.withdrawal.id, adminId: admin.userId, adminRole: "ADMIN" });
    assert.equal(recovered.status, "SUCCESS");
    assert.equal(providerCreateCount, 1, "restart must not create a second provider payout");
    assert.equal(providerStatusCount, 1, "restart must inquire using the stable request reference");

    const replay = await executeWithdrawal({ withdrawalId: created.withdrawal.id, adminId: admin.userId, adminRole: "ADMIN" });
    assert.equal(replay.status, "SUCCESS");
    assert.equal(replay.replayed, true);
    assert.equal(providerCreateCount, 1);

    const [walletAfter] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, user.walletId));
    assert.equal(walletAfter.availableBalance, 70_000);
    assert.equal(walletAfter.pendingBalance, 0);
    assert.equal(walletAfter.lockedBalance, 0);

    const ledgerRows = await db.select().from(schema.walletTransactions).where(and(eq(schema.walletTransactions.walletId, user.walletId), eq(schema.walletTransactions.referenceId, created.withdrawal.id)));
    assert.equal(ledgerRows.length, 2, "one reservation entry and one terminal debit, never a duplicate");
    assert.equal(ledgerRows[0].type, "WITHDRAW");
    assert.equal(ledgerRows[0].amount, 30_000);
  });

  test("crash before local DB commit after provider SUCCESS is recovered by provider-status query without double debit", async () => {
    const user = await createUserWithWallet(100_000);
    const maker = await createUserWithWallet(0, "ADMIN");
    const admin = await createUserWithWallet(0, "ADMIN");
    const created = await createWithdrawal({
      userId: user.userId,
      amount: 20_000,
      bankName: "TEST BANK",
      accountName: "Crash Recovery",
      accountNumber: "1234567890",
      idempotencyKey: `CRASH-STATUS-${randomUUID()}`,
    });
    createdWithdrawalIds.push(created.withdrawal.id);
    await approveWithdrawal(created.withdrawal.id, maker.userId);

    // Commit PROCESSING first, then the external provider succeeds. The process
    // dies before the local SUCCESS transaction; restart must reconcile by status.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${created.withdrawal.id} FOR UPDATE`);
      await tx.update(schema.withdrawals).set({ provider: process.env.PAYOUT_PROVIDER!, status: "PROCESSING", attemptCount: 1, updatedAt: new Date() }).where(eq(schema.withdrawals.id, created.withdrawal.id));
      await tx.insert(schema.withdrawalAttempts).values({
        withdrawalId: created.withdrawal.id,
        attemptNumber: 1,
        fromStatus: "PENDING",
        toStatus: "PROCESSING",
        idempotencyKey: `CRASH-STATUS-ATTEMPT-${created.withdrawal.id}`,
      });
    });

    const { HttpPayoutProvider } = await import("@/server/services/payout-provider");
    const provider = new HttpPayoutProvider(process.env.PAYOUT_PROVIDER!);
    const reference = stablePayoutReference(created.withdrawal.id);
    const providerResult = await provider.createDisbursement({
      reference,
      bankName: created.withdrawal.bankName,
      accountName: created.withdrawal.accountName,
      accountNumber: created.withdrawal.accountNumber,
      amount: created.withdrawal.amount,
    });
    assert.equal(providerResult.status, "SUCCESS");
    assert.equal(providerCreateCount, 1);

    // Simulated process death happens here: provider SUCCESS is durable, but
    // the local SUCCESS/ledger transaction has not run yet.
    const recovered = await executeWithdrawal({ withdrawalId: created.withdrawal.id, adminId: admin.userId, adminRole: "ADMIN" });
    assert.equal(recovered.status, "SUCCESS");
    assert.equal(providerCreateCount, 1, "PROCESSING recovery must query provider status, not create a second payout");
    assert.equal(providerStatusCount, 1);

    const [wallet] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, user.walletId));
    assert.equal(wallet.availableBalance, 80_000);
    assert.equal(wallet.pendingBalance, 0);
    const ledgerRows = await db.select().from(schema.walletTransactions).where(and(eq(schema.walletTransactions.walletId, user.walletId), eq(schema.walletTransactions.referenceId, created.withdrawal.id)));
    assert.equal(ledgerRows.length, 2);
  });

  test("rollback before settlement commit leaves no partial accounting state", async () => {
    const user = await createUserWithWallet(100_000);
    const periodId = randomUUID();
    const typeId = randomUUID();
    const now = Date.now();
    await db.insert(schema.arisanTypes).values({
      id: typeId,
      name: `Crash Settlement ${typeId.slice(0, 8)}`,
      description: "crash recovery",
      contributionAmount: 25_000,
      minimumParticipants: 2,
      maximumParticipants: 2,
      cancellationDeadlineDays: 0,
      platformFeeBps: 100,
      active: true,
    });
    await db.insert(schema.arisanPeriods).values({
      id: periodId,
      typeId,
      code: `CRASH-${periodId.slice(0, 12)}`,
      registrationStartsAt: new Date(now - 120_000),
      registrationEndsAt: new Date(now + 120_000),
      drawingAt: new Date(now + 240_000),
      cancellationDeadlineAt: new Date(now + 180_000),
      minimumParticipants: 2,
      maximumParticipants: 2,
      contributionAmount: 25_000,
      platformFeeBps: 100,
      status: "OPEN",
    });
    createdPeriodIds.push(periodId);
    createdTypeIds.push(typeId);
    const participantId = randomUUID();
    await db.insert(schema.arisanParticipants).values({
      id: participantId,
      periodId,
      userId: user.userId,
      contributionAmount: 25_000,
      status: "ACTIVE",
      eligibleForDrawing: true,
    });
    createdParticipantIds.push(participantId);

    await assert.rejects(
      () => db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM wallets WHERE id = ${user.walletId} FOR UPDATE`);
        const [wallet] = await tx.select().from(schema.wallets).where(eq(schema.wallets.id, user.walletId));
        await tx.update(schema.wallets).set({ availableBalance: wallet.availableBalance - 25_000, lockedBalance: wallet.lockedBalance + 25_000 }).where(eq(schema.wallets.id, wallet.id));
        await tx.insert(schema.walletReservations).values({
          walletId: user.walletId,
          userId: user.userId,
          participantId: participantId,
          periodId,
          amount: 25_000,
          status: "ACTIVE",
        });
        throw new Error("SIMULATED_SERVER_CRASH_BEFORE_SETTLEMENT_COMMIT");
      }),
      /SIMULATED_SERVER_CRASH_BEFORE_SETTLEMENT_COMMIT/i,
    );

    const [walletAfter] = await db.select().from(schema.wallets).where(eq(schema.wallets.id, user.walletId));
    assert.equal(walletAfter.availableBalance, 100_000);
    assert.equal(walletAfter.lockedBalance, 0);
    const reservations = await db.select().from(schema.walletReservations).where(eq(schema.walletReservations.periodId, periodId));
    assert.equal(reservations.length, 0, "uncommitted reservation must not survive restart");
    const [poolAccount] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.code, `ARISAN_POOL:${periodId}`));
    assert.equal(poolAccount, undefined, "no settlement pool may be committed by a crashed transaction");
  });
});

