import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { configureTestDatabase } = await import("../scripts/test-database-guard.mjs");
const databaseUrl = await configureTestDatabase();

test("v11 integration suite requires TEST_DATABASE_URL", { skip: !databaseUrl }, async (t: import("node:test").TestContext) => {
  process.env.DATABASE_URL = databaseUrl!;
  Object.defineProperty(process.env, "NODE_ENV", { value: "test", writable: true, configurable: true, enumerable: true });
  process.env.PAYMENT_PROVIDER = "unconfigured";

  const [{ db, pool }, schema, arisan, wallet, reconciliation, ledger] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
    import("@/server/services/arisan"),
    import("@/server/services/wallet"),
    import("@/server/services/reconciliation"),
    import("@/server/services/ledger"),
  ]);
  t.after(async () => { await pool.end(); });
  const { and, inArray, sql, eq } = await import("drizzle-orm");

  await db.execute(sql`DO $$ DECLARE r RECORD; BEGIN FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations') LOOP EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename); END LOOP; END $$;`);

  const [kycReviewer] = await db.insert(schema.users).values({ name: "Isolated KYC reviewer", phone: "+6281199999999", passwordHash: "test-only", role: "SUPER_ADMIN", status: "ACTIVE", phoneVerifiedAt: new Date() }).returning();
  const makeUser = async (n: number, balance = 100_000) => {
    const [user] = await db.insert(schema.users).values({
      name: `Integration User ${n}`,
      phone: `+62811${String(n).padStart(8, "0")}`,
      email: `integration-${n}-${randomUUID()}@example.test`,
      passwordHash: "test-only",
      role: "USER",
      status: "ACTIVE",
      kycStatus: "VERIFIED",
      kycReviewedBy: kycReviewer.id,
    }).returning();
    const [walletRow] = await db.insert(schema.wallets).values({ userId: user.id, availableBalance: balance }).returning();
    if (balance > 0) {
      const [seedTopup] = await db.insert(schema.topups).values({
        walletId: walletRow.id, userId: user.id, amount: balance, provider: "test",
        providerReference: `TEST-SEED-TOPUP-${user.id}`, checkoutUrl: null,
        idempotencyKey: `TEST-SEED-TOPUP-${user.id}`, status: "SUCCESS",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), paidAt: new Date(),
      }).returning();
      await db.insert(schema.walletTransactions).values({
        walletId: walletRow.id, userId: user.id, type: "TOPUP", direction: "CREDIT", amount: balance,
        availableBefore: 0, availableAfter: balance, lockedBefore: 0, lockedAfter: 0,
        pendingBefore: 0, pendingAfter: 0, referenceType: "topup", referenceId: seedTopup.id,
        description: "Integration test seed", idempotencyKey: `TEST-SEED-${user.id}`,
      });
    }
    return { user, wallet: walletRow };
  };

  await t.test("20 concurrent joins on capacity 5 accept exactly 5 and preserve wallet/reservation invariants", async () => {
    const users = await Promise.all(Array.from({ length: 20 }, (_, i) => makeUser(i + 1)));
    const now = new Date();
    const [type] = await db.insert(schema.arisanTypes).values({
      name: `Integration Type ${randomUUID()}`, contributionAmount: 100_000,
      minimumParticipants: 2, maximumParticipants: 5, platformFeeBps: 0, cancellationDeadlineDays: 1,
    }).returning();
    const [period] = await db.insert(schema.arisanPeriods).values({
      typeId: type.id, code: `INT-JOIN-${randomUUID()}`,
      registrationStartsAt: new Date(now.getTime() - 60_000), registrationEndsAt: new Date(now.getTime() + 60 * 60_000),
      drawingAt: new Date(now.getTime() + 2 * 60 * 60_000), cancellationDeadlineAt: new Date(now.getTime() + 60 * 60_000),
      minimumParticipants: 2, maximumParticipants: 5, contributionAmount: 100_000, platformFeeBps: 0, status: "OPEN",
    }).returning();

    const results = await Promise.all(users.map((u, i) => arisan.joinPeriod({ periodId: period.id, userId: u.user.id, idempotencyKey: `JOIN-${period.id}-${i}`, meta: { ipAddress: "127.0.0.1" } }).then(() => true).catch(() => false)));
    assert.equal(results.filter(Boolean).length, 5);
    const participants = await db.select().from(schema.arisanParticipants).where(eq(schema.arisanParticipants.periodId, period.id));
    assert.equal(participants.length, 5);
    const reservations = await db.select().from(schema.walletReservations).where(eq(schema.walletReservations.periodId, period.id));
    assert.equal(reservations.filter((r) => r.status === "ACTIVE").length, 5);
    const walletRows = await db.select().from(schema.wallets);
    for (const w of walletRows) {
      const active = reservations.filter((r) => r.walletId === w.id && r.status === "ACTIVE").reduce((s, r) => s + r.amount, 0);
      assert.equal(w.lockedBalance, active);
      assert.ok(w.availableBalance >= 0 && w.lockedBalance >= 0 && w.pendingBalance >= 0);
    }
  });

  await t.test("duplicate join and withdrawal idempotency return one financial effect", async () => {
    const user = await makeUser(99, 200_000);
    const now = new Date();
    const [type] = await db.insert(schema.arisanTypes).values({ name: `Idem Type ${randomUUID()}`, contributionAmount: 100_000, minimumParticipants: 2, maximumParticipants: 5, platformFeeBps: 0, cancellationDeadlineDays: 1 }).returning();
    const [period] = await db.insert(schema.arisanPeriods).values({
      typeId: type.id, code: `INT-IDEM-${randomUUID()}`, registrationStartsAt: new Date(now.getTime() - 60_000), registrationEndsAt: new Date(now.getTime() + 60_000),
      drawingAt: new Date(now.getTime() + 120_000), cancellationDeadlineAt: new Date(now.getTime() + 60_000), minimumParticipants: 2, maximumParticipants: 5, contributionAmount: 100_000, status: "OPEN",
    }).returning();
    const key = `DUP-JOIN-${randomUUID()}`;
    const joined = await Promise.all([0, 1].map(() => arisan.joinPeriod({ periodId: period.id, userId: user.user.id, idempotencyKey: key }).catch((e) => e)));
    assert.equal(joined.filter((x) => !(x instanceof Error)).length, 2);
    assert.equal(joined.filter((x) => !(x instanceof Error) && x.replayed).length, 1);
    assert.equal((await db.select().from(schema.arisanParticipants).where(eq(schema.arisanParticipants.periodId, period.id))).length, 1);

    const withdrawalKey = `DUP-WITHDRAW-${randomUUID()}`;
    const withdrawals = await Promise.all([0, 1].map(() => wallet.createWithdrawal({ userId: user.user.id, amount: 50_000, bankName: "TEST", accountName: "Integration", accountNumber: "123456", idempotencyKey: withdrawalKey }).catch((e) => e)));
    assert.equal(withdrawals.filter((x) => !(x instanceof Error)).length, 2);
    const withdrawalRows = await db.select().from(schema.withdrawals).where(eq(schema.withdrawals.userId, user.user.id));
    assert.equal(withdrawalRows.length, 1);
    const [w] = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, user.user.id));
    assert.equal(w.availableBalance, 50_000);
    assert.equal(w.pendingBalance, 50_000);
  });

  await t.test("concurrent withdrawal cannot overspend available balance", async () => {
    const user = await makeUser(100, 100_000);
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => wallet.createWithdrawal({
      userId: user.user.id, amount: 20_000, bankName: "TEST", accountName: "Concurrent", accountNumber: "999999", idempotencyKey: `W-${i}-${randomUUID()}`,
    }).then(() => true).catch(() => false)));
    assert.equal(attempts.filter(Boolean).length, 5);
    const [w] = await db.select().from(schema.wallets).where(eq(schema.wallets.userId, user.user.id));
    assert.equal(w.availableBalance, 0);
    assert.equal(w.pendingBalance, 100_000);
    assert.ok(w.availableBalance >= 0);
  });

  await t.test("concurrent draw settles once and leaves settlement pool at zero", async () => {
    const users = await Promise.all(Array.from({ length: 3 }, (_, i) => makeUser(200 + i)));
    const now = new Date();
    const [type] = await db.insert(schema.arisanTypes).values({ name: `Draw Type ${randomUUID()}`, contributionAmount: 100_000, minimumParticipants: 2, maximumParticipants: 3, platformFeeBps: 100, cancellationDeadlineDays: 1 }).returning();
    const [period] = await db.insert(schema.arisanPeriods).values({
      typeId: type.id, code: `INT-DRAW-${randomUUID()}`, registrationStartsAt: new Date(now.getTime() - 360000), registrationEndsAt: new Date(now.getTime() + 180000),
      drawingAt: new Date(now.getTime() + 360_000), cancellationDeadlineAt: new Date(now.getTime() + 120_000), minimumParticipants: 2, maximumParticipants: 3, contributionAmount: 100_000, platformFeeBps: 100, status: "OPEN",
    }).returning();
    for (let i = 0; i < users.length; i++) await arisan.joinPeriod({ periodId: period.id, userId: users[i].user.id, idempotencyKey: `DRAW-JOIN-${i}-${randomUUID()}` });
    await db.update(schema.arisanPeriods).set({ registrationEndsAt: new Date(now.getTime() - 180000), drawingAt: new Date(now.getTime() - 60000), cancellationDeadlineAt: new Date(now.getTime() - 120000) }).where(eq(schema.arisanPeriods.id, period.id));
    const results = await Promise.all([0, 1, 2, 3].map(() => arisan.drawAndSettle({ periodId: period.id, actorType: "SYSTEM" }).then(() => true).catch(() => false)));
    assert.equal(results.filter(Boolean).length, 1);
    const [updatedPeriod] = await db.select().from(schema.arisanPeriods).where(eq(schema.arisanPeriods.id, period.id));
    assert.equal(updatedPeriod.status, "COMPLETED");
    assert.equal((await db.select().from(schema.drawings).where(eq(schema.drawings.periodId, period.id))).length, 1);
    const [pool] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.code, `ARISAN_POOL:${period.id}`));
    assert.equal(pool.balance, 0);
    const [payout] = await db.select().from(schema.payouts).where(eq(schema.payouts.periodId, period.id));
    assert.equal(payout.grossAmount, 300_000);
    assert.equal(payout.grossAmount, payout.feeAmount + payout.netAmount);

    const poolTransactions = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, pool.id));
    assert.equal(poolTransactions.filter((row) => row.direction === "CREDIT").length, 3);
    assert.equal(poolTransactions.filter((row) => row.direction === "DEBIT").length, 2);
    assert.equal(
      poolTransactions.reduce((sum, row) => sum + (row.direction === "CREDIT" ? row.amount : -row.amount), 0),
      0,
    );

    const winnerRows = await db.select().from(schema.winners).where(eq(schema.winners.periodId, period.id));
    assert.equal(winnerRows.length, 1);
    assert.equal(winnerRows[0].prizeAmount, payout.netAmount);

    const periodFeeRows = await db.select().from(schema.platformFees).where(eq(schema.platformFees.periodId, period.id));
    assert.equal(periodFeeRows.length, 1);
    assert.equal(periodFeeRows[0].amount, payout.feeAmount);

    const [feeAccount] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.code, "PLATFORM_FEE"));
    assert.equal(feeAccount.balance, payout.feeAmount);
    const [walletTotal] = await db.select({
      total: sql<number>`COALESCE(SUM(${schema.wallets.availableBalance} + ${schema.wallets.lockedBalance} + ${schema.wallets.pendingBalance}), 0)`,
    }).from(schema.wallets).where(inArray(schema.wallets.id, users.map((u) => u.wallet.id)));
    assert.equal(Number(walletTotal.total) + feeAccount.balance, payout.grossAmount);

    const [consumedTotal] = await db.select({
      total: sql<number>`COALESCE(SUM(${schema.walletReservations.amount}), 0)`,
    }).from(schema.walletReservations).where(and(eq(schema.walletReservations.periodId, period.id), eq(schema.walletReservations.status, "CONSUMED")));
    assert.equal(Number(consumedTotal.total), payout.grossAmount);

    const settledParticipants = await db.select().from(schema.arisanParticipants).where(eq(schema.arisanParticipants.periodId, period.id));
    assert.equal(settledParticipants.filter((row) => row.status === "ACTIVE").length, 0);
    const consumedReservations = await db.select().from(schema.walletReservations).where(eq(schema.walletReservations.periodId, period.id));
    assert.equal(consumedReservations.filter((row) => row.status === "ACTIVE").length, 0);
  });

  await t.test("concurrent ledger reversals serialize and create only one compensating entry", async () => {
    const reversalUser = await makeUser(501, 100_000);
    const walletTxRows = await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.walletId, reversalUser.wallet.id));
    assert.ok(walletTxRows[0]);
    const originalWalletTx = walletTxRows[0];

    const walletReversals = await Promise.all([
      ledger.reverseWalletTransaction({ actorId: kycReviewer.id, transactionId: originalWalletTx.id, idempotencyKey: `REV-RACE-A-${originalWalletTx.id}`, reason: "concurrency A" }),
      ledger.reverseWalletTransaction({ actorId: kycReviewer.id, transactionId: originalWalletTx.id, idempotencyKey: `REV-RACE-B-${originalWalletTx.id}`, reason: "concurrency B" }),
    ]);
    const walletCompensating = await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.reversalOfId, originalWalletTx.id));
    assert.equal(walletCompensating.length, 1);
    assert.equal(
walletReversals.filter((row) => row !== undefined && row.replayed).length,
  1
);

    const [account] = await db.insert(schema.financialAccounts).values({
      code: `TEST-REV-ACCOUNT-${randomUUID()}`,
      type: "PLATFORM_FEE",
      balance: 100_000,
    }).returning();
    const [originalFinancialTx] = await db.insert(schema.financialTransactions).values({
      accountId: account.id, direction: "CREDIT", amount: 100_000,
      balanceBefore: 0, balanceAfter: 100_000, referenceType: "test", referenceId: null,
      description: "Integration reversal seed", idempotencyKey: `REV-SEED-${randomUUID()}`,
    }).returning();

    const financialReversals = await Promise.all([
      ledger.reverseFinancialTransaction({ actorId: kycReviewer.id, transactionId: originalFinancialTx.id, idempotencyKey: `FIN-REV-RACE-A-${originalFinancialTx.id}`, reason: "concurrency A" }),
      ledger.reverseFinancialTransaction({ actorId: kycReviewer.id, transactionId: originalFinancialTx.id, idempotencyKey: `FIN-REV-RACE-B-${originalFinancialTx.id}`, reason: "concurrency B" }),
    ]);
    const financialCompensating = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.reversalOfId, originalFinancialTx.id));
    assert.equal(financialCompensating.length, 1);
    assert.equal(financialReversals.filter((row) => row.replayed).length, 1);
    const [finalAccount] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.id, account.id));
    assert.equal(finalAccount.balance, 0);
  });

  await t.test("immutable ledgers reject UPDATE and DELETE and reconciliation passes after settlement", async () => {
    const walletTxRows = await db.select().from(schema.walletTransactions).limit(1);
    if (walletTxRows[0]) {
      await assert.rejects(() => db.execute(sql`UPDATE wallet_transactions SET description = 'tamper' WHERE id = ${walletTxRows[0].id}`), (error: unknown) => error instanceof Error && error.cause instanceof Error && /IMMUTABLE_LEDGER/.test(error.cause.message));
      await assert.rejects(() => db.execute(sql`DELETE FROM wallet_transactions WHERE id = ${walletTxRows[0].id}`), (error: unknown) => error instanceof Error && error.cause instanceof Error && /IMMUTABLE_LEDGER/.test(error.cause.message));
    }
    const run = await reconciliation.runAccountingReconciliation();
    assert.equal(run.status, "PASS", JSON.stringify(run.issues));
    assert.equal(run.issueCount, 0);
  });

  await t.test("ledger reversal is append-only and creates a compensating entry", async () => {
    const reversalUser = await makeUser(502, 100_000);
    const txRows = await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.walletId, reversalUser.wallet.id));
    assert.ok(txRows[0]);
    const reversal = await ledger.reverseWalletTransaction({ actorId: kycReviewer.id, transactionId: txRows[0].id, idempotencyKey: `REVERSAL-${txRows[0].id}`, reason: "integration test" });
    assert.ok(reversal, "reversal must exist");
    assert.ok(reversal.transaction.id);
    const [original] = await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.id, txRows[0].id));
    assert.equal(original.reversalOfId, null);
    const [compensating] = await db.select().from(schema.walletTransactions).where(eq(schema.walletTransactions.reversalOfId, original.id));
    assert.ok(compensating);
  });

});
