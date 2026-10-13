import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { assertDisbursementEvidence, getPayoutProvider, stablePayoutReference } from "@/server/services/payout-provider";
import { ApiError } from "@/server/http";
import { processWithdrawal } from "@/server/services/payout-withdrawal";
import {
  arisanParticipants,
  arisanPeriods,
  topups,
  withdrawals,
  users,
  financialAccounts,
  financialTransactions,
  platformFees,
  payouts,
  reconciliationIssues,
  reconciliationRuns,
  walletReservations,
  walletTransactions,
  wallets,
} from "@/db/schema";

type Scope = { periodId?: string | null; recoverProviderSuccess?: boolean; recoveryActorId?: string };

type Issue = {
  severity: "CRITICAL" | "WARNING";
  code: string;
  entityType: string;
  entityId?: string | null;
  expectedValue?: unknown;
  actualValue?: unknown;
  message: string;
};

const money = (value: unknown) => Number(value ?? 0);

export async function runAccountingReconciliation(scope: Scope = {}) {
  if (scope.recoverProviderSuccess) {
    const [actor] = scope.recoveryActorId ? await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, scope.recoveryActorId)).limit(1) : [];
    if (!actor || actor.role !== "SUPER_ADMIN" || actor.status !== "ACTIVE") throw new ApiError("Recovery finansial eksplisit memerlukan super administrator aktif.", "FORBIDDEN", 403);
  }
  const startedAt = new Date();
  const result = await db.transaction(async (tx) => {
    // A repeatable-read snapshot makes the whole report internally consistent.
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const [run] = await tx.insert(reconciliationRuns).values({
      status: "PASS",
      scope: scope.periodId ? "PERIOD" : "GLOBAL",
      periodId: scope.periodId ?? null,
      issueCount: 0,
      startedAt,
    }).returning({ id: reconciliationRuns.id });

    const issues: Issue[] = [];
    type IssueInput = Omit<Issue, "severity"> & { severity?: Issue["severity"] };
    const add = (issue: IssueInput) => issues.push({ ...issue, severity: issue.severity ?? "CRITICAL" });

    // 1. Wallet reservation invariant: locked balance must equal active reservations.
    const walletInvariantRows = await tx.execute(sql`
      SELECT w.id,
             w.available_balance AS available,
             w.locked_balance AS locked,
             w.pending_balance AS pending,
             COALESCE(r.active_total, 0) AS expected_locked
      FROM wallets w
      LEFT JOIN (
        SELECT wallet_id, SUM(amount) AS active_total
        FROM wallet_reservations
        WHERE status = 'ACTIVE'
        GROUP BY wallet_id
      ) r ON r.wallet_id = w.id
      WHERE w.available_balance < 0 OR w.locked_balance < 0 OR w.pending_balance < 0
         OR w.locked_balance <> COALESCE(r.active_total, 0)
    `);
    for (const row of walletInvariantRows.rows as Array<Record<string, unknown>>) {
      const walletId = String(row.id);
      if (money(row.locked) !== money(row.expected_locked)) {
        add({ code: "WALLET_LOCKED_RESERVATION_MISMATCH", entityType: "wallet", entityId: walletId, expectedValue: { lockedBalance: money(row.expected_locked) }, actualValue: { lockedBalance: money(row.locked) }, message: "lockedBalance tidak sama dengan total reservation ACTIVE." });
      }
      if (money(row.available) < 0 || money(row.locked) < 0 || money(row.pending) < 0) {
        add({ code: "WALLET_NEGATIVE_BALANCE", entityType: "wallet", entityId: walletId, message: "Wallet memiliki saldo negatif." });
      }
    }

    // 2. Reservation integrity: reservation must point to the same user/period/amount as participant.
    const reservationIntegrityRows = await tx.execute(sql`
      SELECT wr.id, wr.user_id AS "userId", wr.period_id AS "periodId", wr.amount,
             ap.user_id AS "participantUserId", ap.period_id AS "participantPeriodId",
             ap.contribution_amount AS "participantAmount"
      FROM wallet_reservations wr
      INNER JOIN arisan_participants ap ON ap.id = wr.participant_id
      WHERE (${scope.periodId ?? null}::uuid IS NULL OR wr.period_id = ${scope.periodId ?? null}::uuid)
        AND (wr.user_id <> ap.user_id OR wr.period_id <> ap.period_id OR wr.amount <> ap.contribution_amount)
    `);
    for (const r of reservationIntegrityRows.rows as Array<Record<string, unknown>>) {
      add({ code: "RESERVATION_PARTICIPANT_MISMATCH", entityType: "wallet_reservation", entityId: String(r.id), expectedValue: { userId: r.participantUserId, periodId: r.participantPeriodId, amount: money(r.participantAmount) }, actualValue: { userId: r.userId, periodId: r.periodId, amount: money(r.amount) }, message: "Reservation tidak konsisten dengan participant." });
    }

    // 3. Referential integrity: every wallet ledger row must have a valid
    // parent transaction, and every financially completed parent must have its
    // corresponding wallet ledger. Foreign keys alone do not cover polymorphic
    // referenceType/referenceId pairs.
    const orphanWalletRows = await tx.execute(sql`
      SELECT wt.id, wt.type, wt.reference_type AS "referenceType", wt.reference_id AS "referenceId"
      FROM wallet_transactions wt
      LEFT JOIN topups t ON wt.reference_type = 'topup' AND wt.reference_id = t.id
      LEFT JOIN withdrawals w ON wt.reference_type = 'withdrawal' AND wt.reference_id = w.id
      LEFT JOIN payouts p ON wt.reference_type = 'payout' AND wt.reference_id = p.id
      LEFT JOIN arisan_periods ap ON wt.reference_type = 'arisan_period' AND wt.reference_id = ap.id
      LEFT JOIN arisan_participants participant ON wt.reference_type = 'arisan_participant' AND wt.reference_id = participant.id
      LEFT JOIN wallet_transactions original ON wt.reference_type = 'wallet_transaction_reversal' AND wt.reference_id = original.id
      WHERE wt.reference_id IS NULL
         OR (wt.reference_type = 'topup' AND t.id IS NULL)
         OR (wt.reference_type = 'withdrawal' AND w.id IS NULL)
         OR (wt.reference_type = 'payout' AND p.id IS NULL)
         OR (wt.reference_type = 'arisan_period' AND ap.id IS NULL)
         OR (wt.reference_type = 'arisan_participant' AND (participant.id IS NULL OR participant.user_id <> wt.user_id))
         OR (wt.reference_type = 'wallet_transaction_reversal' AND (original.id IS NULL OR original.wallet_id <> wt.wallet_id OR wt.reversal_of_id IS DISTINCT FROM original.id))
         OR wt.reference_type NOT IN ('topup', 'withdrawal', 'payout', 'arisan_period', 'arisan_participant', 'wallet_transaction_reversal')
    `);
    for (const row of orphanWalletRows.rows as Array<Record<string, unknown>>) {
      add({ severity: "CRITICAL", code: "WALLET_LEDGER_ORPHAN_PARENT", entityType: "wallet_transaction", entityId: String(row.id), expectedValue: { referenceType: row.referenceType, referenceId: row.referenceId }, actualValue: row, message: "Wallet ledger tidak memiliki parent transaction yang valid." });
    }

    const missingTopupLedger = await tx.execute(sql`
      SELECT t.id
      FROM topups t
      LEFT JOIN wallet_transactions wt
        ON wt.reference_type = 'topup' AND wt.reference_id = t.id AND wt.type = 'TOPUP'
      WHERE t.status = 'SUCCESS' AND wt.id IS NULL
    `);
    for (const row of missingTopupLedger.rows as Array<Record<string, unknown>>) {
      add({ severity: "CRITICAL", code: "PARENT_TRANSACTION_WITHOUT_LEDGER", entityType: "topup", entityId: String(row.id), expectedValue: { walletLedger: true }, actualValue: { walletLedger: false }, message: "Top-up SUCCESS tidak memiliki wallet ledger." });
    }

    const missingWithdrawalLedger = await tx.execute(sql`
      SELECT w.id, w.status
      FROM withdrawals w
      LEFT JOIN wallet_transactions wt
        ON wt.reference_type = 'withdrawal' AND wt.reference_id = w.id
      WHERE wt.id IS NULL
    `);
    for (const row of missingWithdrawalLedger.rows as Array<Record<string, unknown>>) {
      add({ severity: "CRITICAL", code: "PARENT_TRANSACTION_WITHOUT_LEDGER", entityType: "withdrawal", entityId: String(row.id), expectedValue: { walletLedger: true }, actualValue: { walletLedger: false, status: row.status }, message: "Withdrawal tidak memiliki wallet ledger." });
    }

    const pendingRows = await tx.execute(sql`
      SELECT w.id, w.pending_balance, COALESCE(reserved.amount, 0) AS expected
      FROM wallets w LEFT JOIN (
        SELECT wallet_id, SUM(amount) AS amount FROM withdrawals WHERE status IN ('PENDING', 'PROCESSING', 'FAILED_RETRYABLE') GROUP BY wallet_id
      ) reserved ON reserved.wallet_id = w.id WHERE w.pending_balance <> COALESCE(reserved.amount, 0)
    `);
    for (const row of pendingRows.rows as Array<Record<string, unknown>>) {
      add({ code: "WALLET_PENDING_WITHDRAWAL_MISMATCH", entityType: "wallet", entityId: String(row.id), expectedValue: { pending: row.expected }, actualValue: { pending: row.pending_balance }, message: "Saldo pending tidak sama dengan withdrawal aktif." });
    }
    const missingClosingLedger = await tx.execute(sql`
      SELECT w.id, w.status FROM withdrawals w WHERE w.status IN ('SUCCESS', 'FAILED_FINAL')
      AND NOT EXISTS (SELECT 1 FROM wallet_transactions wt WHERE wt.reference_type = 'withdrawal' AND wt.reference_id = w.id
        AND wt.idempotency_key = 'WITHDRAWAL-' || w.id::text || '-' || w.status::text)
    `);
    for (const row of missingClosingLedger.rows as Array<Record<string, unknown>>) {
      add({ code: "WITHDRAWAL_TERMINAL_LEDGER_MISSING", entityType: "withdrawal", entityId: String(row.id), actualValue: { status: row.status }, message: "Withdrawal terminal tidak memiliki ledger penyelesaian/refund; jangan mengarang koreksi tanpa bukti provider." });
    }
    const walletsWithoutLedger = await tx.execute(sql`
      SELECT w.id FROM wallets w WHERE (w.available_balance <> 0 OR w.locked_balance <> 0 OR w.pending_balance <> 0)
      AND NOT EXISTS (SELECT 1 FROM wallet_transactions wt WHERE wt.wallet_id = w.id)
    `);
    for (const row of walletsWithoutLedger.rows as Array<Record<string, unknown>>) add({ code: "WALLET_BALANCE_WITHOUT_LEDGER", entityType: "wallet", entityId: String(row.id), message: "Wallet bersaldo tidak memiliki riwayat ledger." });

    const withdrawalMetadataIssues = await tx.execute(sql`
      SELECT id, status, provider_reference AS "providerReference",
             last_error_code AS "lastErrorCode", last_error_message AS "lastErrorMessage",
             next_retry_at AS "nextRetryAt"
      FROM withdrawals
      WHERE (status = 'SUCCESS' AND (provider_reference IS NULL OR btrim(provider_reference) = '' OR last_provider_evidence IS NULL))
         OR (status = 'FAILED_FINAL' AND (
              last_error_code = 'PROVIDER_RETRYABLE_FAILURE'
              OR last_error_message ILIKE '%dana tetap ditahan untuk retry%'
            ))
         OR (status = 'FAILED_RETRYABLE' AND next_retry_at IS NULL)
    `);
    for (const row of withdrawalMetadataIssues.rows as Array<Record<string, unknown>>) {
      const code = row.status === "SUCCESS"
        ? "WITHDRAWAL_SUCCESS_MISSING_PROVIDER_REFERENCE"
        : row.status === "FAILED_FINAL"
          ? "WITHDRAWAL_FINAL_RETRYABLE_METADATA"
          : "WITHDRAWAL_RETRY_SCHEDULE_MISSING";
      add({ severity: "CRITICAL", code, entityType: "withdrawal", entityId: String(row.id), expectedValue: { statusMetadataConsistent: true }, actualValue: row, message: "Metadata withdrawal terminal/retry tidak konsisten; status/saldo tidak diubah tanpa verifikasi provider." });
    }

    const prematureWithdrawalRetries = await tx.execute(sql`
      SELECT failed.withdrawal_id AS "withdrawalId",
             retry.attempt_number AS "attemptNumber",
             retry.created_at AS "retryStartedAt",
             failed.next_retry_at AS "nextRetryAt"
      FROM withdrawal_attempts failed
      INNER JOIN withdrawal_attempts retry
        ON retry.withdrawal_id = failed.withdrawal_id
       AND retry.attempt_number = failed.attempt_number + 1
       AND retry.from_status = 'FAILED_RETRYABLE'
       AND retry.to_status = 'PROCESSING'
      WHERE failed.to_status = 'FAILED_RETRYABLE'
        AND failed.next_retry_at IS NOT NULL
        AND retry.created_at < failed.next_retry_at
    `);
    for (const row of prematureWithdrawalRetries.rows as Array<Record<string, unknown>>) {
      add({ severity: "CRITICAL", code: "WITHDRAWAL_RETRY_BEFORE_DUE", entityType: "withdrawal", entityId: String(row.withdrawalId), expectedValue: { retryStartedAtOrAfter: row.nextRetryAt }, actualValue: { attemptNumber: row.attemptNumber, retryStartedAt: row.retryStartedAt, nextRetryAt: row.nextRetryAt }, message: "Attempt withdrawal tercatat sebelum next_retry_at; tinjau audit dan bukti provider eksternal." });
    }

    const missingPayoutLedger = await tx.execute(sql`
      SELECT p.id
      FROM payouts p
      LEFT JOIN wallet_transactions wt
        ON wt.reference_type = 'payout' AND wt.reference_id = p.id
      WHERE p.status = 'SUCCESS' AND wt.id IS NULL
    `);
    for (const row of missingPayoutLedger.rows as Array<Record<string, unknown>>) {
      add({ severity: "CRITICAL", code: "PARENT_TRANSACTION_WITHOUT_LEDGER", entityType: "payout", entityId: String(row.id), expectedValue: { walletLedger: true }, actualValue: { walletLedger: false }, message: "Payout SUCCESS tidak memiliki wallet ledger." });
    }

    // Duplicate idempotency/provider references are audited explicitly even
    // though current schema constraints should prevent new duplicates. This
    // catches legacy/corrupted data and cross-table collisions.
    const duplicateIdempotency = await tx.execute(sql`
      SELECT source, idempotency_key AS "idempotencyKey", COUNT(*)::int AS count
      FROM (
        SELECT 'wallet_transactions' AS source, idempotency_key FROM wallet_transactions
        UNION ALL SELECT 'topups', idempotency_key FROM topups
        UNION ALL SELECT 'withdrawals', idempotency_key FROM withdrawals
        UNION ALL SELECT 'payouts', idempotency_key FROM payouts
        UNION ALL SELECT 'financial_transactions', idempotency_key FROM financial_transactions
      ) x
      GROUP BY source, idempotency_key
      HAVING COUNT(*) > 1
    `);
    for (const row of duplicateIdempotency.rows as Array<Record<string, unknown>>) {
      add({ severity: "CRITICAL", code: "DUPLICATE_IDEMPOTENCY_KEY", entityType: String(row.source), expectedValue: { count: 1 }, actualValue: { count: Number(row.count), idempotencyKey: row.idempotencyKey }, message: "Idempotency key muncul lebih dari satu kali dalam satu transaction domain." });
    }

    const duplicateProviderReference = await tx.execute(sql`
      SELECT provider_reference AS "providerReference", COUNT(*)::int AS count,
             ARRAY_AGG(source || ':' || id::text) AS entities
      FROM (
        SELECT 'topup' AS source, id, provider_reference FROM topups WHERE provider_reference IS NOT NULL
        UNION ALL
        SELECT 'withdrawal' AS source, id, provider_reference FROM withdrawals WHERE provider_reference IS NOT NULL
        UNION ALL
        SELECT 'payout' AS source, id, provider_reference FROM payouts WHERE provider_reference IS NOT NULL
      ) x
      GROUP BY provider_reference
      HAVING COUNT(*) > 1
    `);
    for (const row of duplicateProviderReference.rows as Array<Record<string, unknown>>) {
      add({ severity: "CRITICAL", code: "DUPLICATE_PROVIDER_REFERENCE", entityType: "provider_reference", expectedValue: { count: 1 }, actualValue: { count: Number(row.count), providerReference: row.providerReference, entities: row.entities }, message: "Provider reference digunakan oleh lebih dari satu transaksi provider." });
    }

    // 4. Wallet transaction continuity: every transaction's opening balances must match the previous closing balances.
    const walletBatchSize = Math.max(50, Math.min(500, Number(process.env.RECONCILIATION_WALLET_BATCH_SIZE) || 200));
    let walletCursor: string | null = null;
    while (true) {
      const walletIdRows: Array<{ walletId: string }> = scope.periodId
        ? await tx.selectDistinct({ walletId: walletReservations.walletId }).from(walletReservations)
            .where(and(eq(walletReservations.periodId, scope.periodId), walletCursor ? gt(walletReservations.walletId, walletCursor) : sql`true`))
            .orderBy(walletReservations.walletId).limit(walletBatchSize)
        : await tx.select({ walletId: wallets.id }).from(wallets)
            .where(walletCursor ? gt(wallets.id, walletCursor) : sql`true`)
            .orderBy(wallets.id).limit(walletBatchSize);
      const walletIds: string[] = walletIdRows.map((row) => row.walletId);
      if (!walletIds.length) break;
    for (const walletId of walletIds) {
      const txRows = await tx.select().from(walletTransactions).where(eq(walletTransactions.walletId, walletId)).orderBy(asc(walletTransactions.ledgerSequence));
      let previous: typeof txRows[number] | null = null;
      for (const row of txRows) {
        const availableBefore = money(row.availableBefore);
        const availableAfter = money(row.availableAfter);
        const lockedBefore = money(row.lockedBefore);
        const lockedAfter = money(row.lockedAfter);
        const pendingBefore = money(row.pendingBefore);
        const pendingAfter = money(row.pendingAfter);
        const amount = money(row.amount);

        if (!previous && (availableBefore !== 0 || lockedBefore !== 0 || pendingBefore !== 0)) {
          add({ code: "WALLET_LEDGER_OPENING_MISMATCH", entityType: "wallet_transaction", entityId: row.id, actualValue: { availableBefore, lockedBefore, pendingBefore }, message: "Opening ledger wallet bukan nol; bukti opening balance historis diperlukan." });
        }
        if (previous && (availableBefore !== money(previous.availableAfter) || lockedBefore !== money(previous.lockedAfter) || pendingBefore !== money(previous.pendingAfter))) {
          add({ code: "WALLET_LEDGER_CHAIN_BROKEN", entityType: "wallet_transaction", entityId: row.id, expectedValue: { availableBefore: money(previous.availableAfter), lockedBefore: money(previous.lockedAfter), pendingBefore: money(previous.pendingAfter) }, actualValue: { availableBefore, lockedBefore, pendingBefore }, message: "Rantai saldo wallet transaction terputus." });
        }

        const delta = {
          available: availableAfter - availableBefore,
          locked: lockedAfter - lockedBefore,
          pending: pendingAfter - pendingBefore,
        };
        const same = (a: number, b: number) => a === b;
        const validSemanticMovement = (() => {
          switch (row.type) {
            case "TOPUP":
              return row.direction === "CREDIT" && same(delta.available, amount) && delta.locked === 0 && delta.pending === 0;
            case "JOIN_ARISAN":
              return row.direction === "DEBIT" && same(delta.available, -amount) && same(delta.locked, amount) && delta.pending === 0;
            case "CANCEL_ARISAN":
            case "UNLOCK_ARISAN":
              return row.direction === "CREDIT" && same(delta.available, amount) && same(delta.locked, -amount) && delta.pending === 0;
            case "PAYOUT":
              return row.direction === "DEBIT"
                ? same(delta.available, 0) && same(delta.locked, -amount) && delta.pending === 0
                : row.direction === "CREDIT" && same(delta.available, amount) && delta.locked === 0 && delta.pending === 0;
            case "WITHDRAW":
              return row.direction === "DEBIT" && (
                (same(delta.available, -amount) && same(delta.pending, amount) && delta.locked === 0) ||
                (delta.available === 0 && same(delta.pending, -amount) && delta.locked === 0)
              );
            case "REFUND":
              return row.direction === "CREDIT" && (
                (same(delta.available, amount) && same(delta.locked, -amount) && delta.pending === 0) ||
                (same(delta.available, amount) && delta.locked === 0 && same(delta.pending, -amount))
              );
            case "ADJUSTMENT":
              return Boolean(row.reversalOfId);
            default:
              return false;
          }
        })();

        if (!validSemanticMovement) {
          add({
            code: "WALLET_LEDGER_SEMANTIC_MISMATCH",
            entityType: "wallet_transaction",
            entityId: row.id,
            expectedValue: { type: row.type, direction: row.direction, amount },
            actualValue: { delta },
            message: "Perubahan available/locked/pending tidak sesuai dengan jenis transaksi wallet.",
          });
        }

        if (row.type === "ADJUSTMENT" && row.reversalOfId) {
          const [original] = await tx.select({
            availableBefore: walletTransactions.availableBefore,
            availableAfter: walletTransactions.availableAfter,
            lockedBefore: walletTransactions.lockedBefore,
            lockedAfter: walletTransactions.lockedAfter,
            pendingBefore: walletTransactions.pendingBefore,
            pendingAfter: walletTransactions.pendingAfter,
            amount: walletTransactions.amount,
            direction: walletTransactions.direction,
          }).from(walletTransactions).where(eq(walletTransactions.id, row.reversalOfId)).limit(1);
          if (!original || money(original.amount) !== amount || original.direction === row.direction ||
              delta.available !== -(money(original.availableAfter) - money(original.availableBefore)) ||
              delta.locked !== -(money(original.lockedAfter) - money(original.lockedBefore)) ||
              delta.pending !== -(money(original.pendingAfter) - money(original.pendingBefore))) {
            add({
              code: "WALLET_REVERSAL_INVARIANT_MISMATCH",
              entityType: "wallet_transaction",
              entityId: row.id,
              expectedValue: { reversalOfId: row.reversalOfId },
              actualValue: { originalFound: Boolean(original), amount, direction: row.direction, delta },
              message: "Reversal wallet tidak merupakan inverse exact dari transaksi asal.",
            });
          }
        }

        previous = row;
      }
      if (previous) {
        const [wallet] = await tx.select({ available: wallets.availableBalance, locked: wallets.lockedBalance, pending: wallets.pendingBalance }).from(wallets).where(eq(wallets.id, walletId)).limit(1);
        if (wallet && (money(previous.availableAfter) !== money(wallet.available) || money(previous.lockedAfter) !== money(wallet.locked) || money(previous.pendingAfter) !== money(wallet.pending))) {
          add({ code: "WALLET_LEDGER_BALANCE_MISMATCH", entityType: "wallet", entityId: walletId, expectedValue: { available: money(previous.availableAfter), locked: money(previous.lockedAfter), pending: money(previous.pendingAfter) }, actualValue: { available: money(wallet.available), locked: money(wallet.locked), pending: money(wallet.pending) }, message: "Saldo wallet saat ini tidak sama dengan closing balance transaksi terakhir." });
        }
      }
    }
      walletCursor = walletIds[walletIds.length - 1];
      if (walletIds.length < walletBatchSize) break;
    }

    // 4. Financial account ledger continuity and balance.
    const accounts = await tx.select().from(financialAccounts).where(scope.periodId ? eq(financialAccounts.periodId, scope.periodId) : sql`true`);
    for (const account of accounts) {
      const rows = await tx.select().from(financialTransactions).where(eq(financialTransactions.accountId, account.id)).orderBy(asc(financialTransactions.ledgerSequence));
      let expectedBalance = 0;
      let previous: typeof rows[number] | null = null;
      for (const row of rows) {
        if (money(row.balanceBefore) !== expectedBalance) {
          add({ code: "FINANCIAL_LEDGER_OPENING_MISMATCH", entityType: "financial_transaction", entityId: row.id, expectedValue: { balanceBefore: expectedBalance }, actualValue: { balanceBefore: money(row.balanceBefore) }, message: "Opening balance financial transaction tidak sesuai dengan ledger sebelumnya." });
        }
        if (previous && money(row.balanceBefore) !== money(previous.balanceAfter)) {
          add({ code: "FINANCIAL_LEDGER_CHAIN_BROKEN", entityType: "financial_transaction", entityId: row.id, expectedValue: { balanceBefore: money(previous.balanceAfter) }, actualValue: { balanceBefore: money(row.balanceBefore) }, message: "Rantai financial ledger terputus." });
        }
        const amount = money(row.amount);
        expectedBalance += row.direction === "CREDIT" ? amount : -amount;
        if (expectedBalance < 0) {
          add({ code: "FINANCIAL_ACCOUNT_NEGATIVE", entityType: "financial_account", entityId: account.id, message: "Financial account menjadi negatif berdasarkan ledger." });
        }
        if (money(row.balanceAfter) !== expectedBalance) {
          add({ code: "FINANCIAL_LEDGER_BALANCE_MISMATCH", entityType: "financial_transaction", entityId: row.id, expectedValue: { balanceAfter: expectedBalance }, actualValue: { balanceAfter: money(row.balanceAfter) }, message: "balanceAfter financial transaction tidak sesuai arah transaksi." });
        }
        previous = row;
      }
      if (money(account.balance) !== expectedBalance) {
        add({ code: "FINANCIAL_ACCOUNT_BALANCE_MISMATCH", entityType: "financial_account", entityId: account.id, expectedValue: { balance: expectedBalance }, actualValue: { balance: money(account.balance) }, message: "Saldo financial account tidak sama dengan hasil ledger." });
      }
    }

    // 6. Period pool invariant and payout arithmetic.
    const periods = await tx.select().from(arisanPeriods).where(scope.periodId ? eq(arisanPeriods.id, scope.periodId) : sql`true`);
    const [feeAccount] = await tx.select().from(financialAccounts).where(eq(financialAccounts.code, "PLATFORM_FEE")).limit(1);
    for (const period of periods) {
      const [active] = await tx.select({ total: sql<number>`COALESCE(SUM(${arisanParticipants.contributionAmount}), 0)` })
        .from(arisanParticipants).where(and(eq(arisanParticipants.periodId, period.id), eq(arisanParticipants.status, "ACTIVE")));
      const expectedActivePool = money(active?.total);
      const [pool] = await tx.select({ id: financialAccounts.id, balance: financialAccounts.balance }).from(financialAccounts).where(eq(financialAccounts.code, `ARISAN_POOL:${period.id}`)).limit(1);
      if (!pool) {
        if (expectedActivePool > 0 || ["COMPLETED", "CANCELLED"].includes(period.status)) {
          add({ code: "SETTLEMENT_POOL_ACCOUNT_MISSING", entityType: "arisan_period", entityId: period.id, expectedValue: { poolBalance: expectedActivePool }, message: "Akun settlement pool tidak ditemukan." });
        }
      } else {
        // Participant contributions stay reserved in wallets until settlement.
        // The ARISAN_POOL account is funded only inside drawAndSettle, and that
        // transaction commits only after the pool has been fully consumed.
        // Therefore a committed non-terminal period must still have a zero
        // accounting-pool balance; active reservations are not pool-account
        // balance yet.
        const expectedPool = 0;
        if (money(pool.balance) !== expectedPool) {
          add({ code: "SETTLEMENT_POOL_BALANCE_MISMATCH", entityType: "financial_account", entityId: pool.id, expectedValue: { balance: expectedPool }, actualValue: { balance: money(pool.balance) }, message: "Saldo settlement pool tidak sama dengan posisi participant." });
        }
      }

      const [payout] = await tx.select().from(payouts).where(eq(payouts.periodId, period.id)).limit(1);
      const participantRows = await tx.select({ amount: arisanParticipants.contributionAmount }).from(arisanParticipants).where(and(eq(arisanParticipants.periodId, period.id), inArray(arisanParticipants.status, ["WINNER", "COMPLETED"])));
      const completedGross = participantRows.reduce((sum, row) => sum + money(row.amount), 0);
      if (payout) {
        if (money(payout.grossAmount) !== money(payout.feeAmount) + money(payout.netAmount)) {
          add({ code: "PAYOUT_ARITHMETIC_MISMATCH", entityType: "payout", entityId: payout.id, message: "grossAmount tidak sama dengan feeAmount + netAmount." });
        }
        if (period.status === "COMPLETED" && money(payout.grossAmount) !== completedGross) {
          add({ code: "PAYOUT_GROSS_PARTICIPANT_MISMATCH", entityType: "payout", entityId: payout.id, expectedValue: { grossAmount: completedGross }, actualValue: { grossAmount: money(payout.grossAmount) }, message: "Gross payout tidak sama dengan total kontribusi peserta yang selesai." });
        }
      } else if (period.status === "COMPLETED") {
        add({ code: "COMPLETED_PERIOD_WITHOUT_PAYOUT", entityType: "arisan_period", entityId: period.id, message: "Periode COMPLETED tidak memiliki payout." });
      }

      const [reservationTotals] = await tx.select({
        active: sql<number>`COALESCE(SUM(CASE WHEN ${walletReservations.status} = 'ACTIVE' THEN ${walletReservations.amount} ELSE 0 END), 0)`,
        released: sql<number>`COALESCE(SUM(CASE WHEN ${walletReservations.status} = 'RELEASED' THEN ${walletReservations.amount} ELSE 0 END), 0)`,
        consumed: sql<number>`COALESCE(SUM(CASE WHEN ${walletReservations.status} = 'CONSUMED' THEN ${walletReservations.amount} ELSE 0 END), 0)`,
      }).from(walletReservations).where(eq(walletReservations.periodId, period.id));
      const [participantTotal] = await tx.select({
        total: sql<number>`COALESCE(SUM(${arisanParticipants.contributionAmount}), 0)`,
      }).from(arisanParticipants).where(eq(arisanParticipants.periodId, period.id));
      const reservationTotal = money(reservationTotals?.active) + money(reservationTotals?.released) + money(reservationTotals?.consumed);
      if (reservationTotal !== money(participantTotal?.total)) {
        add({
          code: "RESERVATION_LIFECYCLE_TOTAL_MISMATCH",
          entityType: "arisan_period",
          entityId: period.id,
          expectedValue: { participantContributionTotal: money(participantTotal?.total) },
          actualValue: { active: money(reservationTotals?.active), released: money(reservationTotals?.released), consumed: money(reservationTotals?.consumed) },
          message: "Total reservation ACTIVE + RELEASED + CONSUMED tidak sama dengan total kontribusi peserta.",
        });
      }
      if (period.status === "COMPLETED" && payout && money(reservationTotals?.consumed) !== money(payout.grossAmount)) {
        add({
          code: "CONSUMED_RESERVATION_GROSS_MISMATCH",
          entityType: "payout",
          entityId: payout.id,
          expectedValue: { consumedReservations: money(reservationTotals?.consumed) },
          actualValue: { grossAmount: money(payout.grossAmount) },
          message: "Reservation yang dikonsumsi tidak sama dengan gross settlement.",
        });
      }
      if (period.status === "COMPLETED" && (money(reservationTotals?.active) !== 0 || money(reservationTotals?.released) !== 0)) {
        add({
          code: "COMPLETED_PERIOD_RESERVATION_NOT_CONSUMED",
          entityType: "arisan_period",
          entityId: period.id,
          expectedValue: { active: 0, released: 0 },
          actualValue: { active: money(reservationTotals?.active), released: money(reservationTotals?.released) },
          message: "Periode COMPLETED masih memiliki reservation ACTIVE/RELEASED.",
        });
      }
      if (period.status === "CANCELLED" && payout === undefined && money(reservationTotals?.active) !== 0) {
        add({
          code: "CANCELLED_PERIOD_ACTIVE_RESERVATION",
          entityType: "arisan_period",
          entityId: period.id,
          expectedValue: { active: 0 },
          actualValue: { active: money(reservationTotals?.active) },
          message: "Periode CANCELLED masih memiliki reservation ACTIVE.",
        });
      }

      if (payout) {
        const [poolAccount] = await tx.select({ id: financialAccounts.id, balance: financialAccounts.balance })
          .from(financialAccounts).where(eq(financialAccounts.code, `ARISAN_POOL:${period.id}`)).limit(1);
        if (poolAccount) {
          const poolRows = await tx.select({ direction: financialTransactions.direction, amount: financialTransactions.amount, referenceType: financialTransactions.referenceType })
            .from(financialTransactions).where(and(eq(financialTransactions.accountId, poolAccount.id), eq(financialTransactions.referenceId, payout.id)));
          const poolCredits = poolRows.filter((r) => r.direction === "CREDIT").reduce((sum, r) => sum + money(r.amount), 0);
          const winnerDebits = poolRows.filter((r) => r.direction === "DEBIT" && r.referenceType === "payout").reduce((sum, r) => sum + money(r.amount), 0);
          const feeDebits = poolRows.filter((r) => r.direction === "DEBIT" && r.referenceType === "platform_fee").reduce((sum, r) => sum + money(r.amount), 0);
          if (poolCredits !== money(payout.grossAmount) || winnerDebits !== money(payout.netAmount) || feeDebits !== money(payout.feeAmount)) {
            add({
              code: "SETTLEMENT_POOL_FLOW_MISMATCH",
              entityType: "payout",
              entityId: payout.id,
              expectedValue: { credits: money(payout.grossAmount), winnerDebits: money(payout.netAmount), feeDebits: money(payout.feeAmount) },
              actualValue: { credits: poolCredits, winnerDebits, feeDebits },
              message: "Arus ledger settlement pool tidak sama dengan gross/net/fee payout.",
            });
          }
        }

        const [feeRows] = feeAccount
          ? await tx.select({ total: sql<number>`COALESCE(SUM(${financialTransactions.amount}), 0)` })
              .from(financialTransactions)
              .where(and(eq(financialTransactions.accountId, feeAccount.id), eq(financialTransactions.direction, "CREDIT"), eq(financialTransactions.referenceId, payout.id)))
          : [{ total: 0 }];
        if (money(feeRows?.total) !== money(payout.feeAmount)) {
          add({
            code: "PLATFORM_FEE_PAYOUT_FLOW_MISMATCH",
            entityType: "payout",
            entityId: payout.id,
            expectedValue: { feeAmount: money(payout.feeAmount) },
            actualValue: { feeLedgerCredit: money(feeRows?.total) },
            message: "Credit platform fee untuk payout tidak sama dengan feeAmount.",
          });
        }
      }
    }

    // 7. Platform fee account must equal the platform fee records currently recorded.
    const [feeTotal] = await tx.select({ total: sql<number>`COALESCE(SUM(${platformFees.amount}), 0)` }).from(platformFees);
    if (feeAccount && money(feeAccount.balance) !== money(feeTotal?.total)) {
      add({ code: "PLATFORM_FEE_BALANCE_MISMATCH", entityType: "financial_account", entityId: feeAccount.id, expectedValue: { balance: money(feeTotal?.total) }, actualValue: { balance: money(feeAccount.balance) }, message: "Saldo platform fee tidak sama dengan total platformFees." });
    }

    if (issues.length) {
      await tx.insert(reconciliationIssues).values(issues.map((issue) => ({ runId: run.id, ...issue })));
    }
    const status = issues.length ? "FAIL" : "PASS";
    const completedAt = new Date();
    await tx.update(reconciliationRuns).set({ status, issueCount: issues.length, completedAt }).where(eq(reconciliationRuns.id, run.id));
    return { runId: run.id, status, issueCount: issues.length, issues, startedAt, completedAt };
  });

  // Provider state is checked outside the DB transaction so a slow/unavailable
  // external API never holds a financial reconciliation transaction open.
  const providerIssuePreview: Issue[] = [];
  let providerIssueCount = 0;
  const persistProviderIssues = async (batch: Issue[]) => {
    if (!batch.length) return;
    await db.transaction(async (tx) => {
      await tx.insert(reconciliationIssues).values(batch.map((issue) => ({ runId: result.runId, ...issue })));
      await tx.update(reconciliationRuns).set({
        status: "FAIL",
        issueCount: sql`${reconciliationRuns.issueCount} + ${batch.length}`,
        completedAt: new Date(),
      }).where(eq(reconciliationRuns.id, result.runId));
    });
    providerIssueCount += batch.length;
    providerIssuePreview.push(...batch.slice(0, Math.max(0, 50 - providerIssuePreview.length)));
  };
  try {
    const batchSize = Math.max(10, Math.min(200, Number(process.env.RECONCILIATION_PROVIDER_BATCH_SIZE) || 100));
    let afterId: string | null = null;
    while (true) {
      const processingWithdrawals = await db.select({
        id: withdrawals.id, providerReference: withdrawals.providerReference, provider: withdrawals.provider,
        amount: withdrawals.amount, attemptCount: withdrawals.attemptCount,
      }).from(withdrawals).where(afterId
        ? and(eq(withdrawals.status, "PROCESSING"), gt(withdrawals.id, afterId))
        : eq(withdrawals.status, "PROCESSING")).orderBy(withdrawals.id).limit(batchSize);
      if (!processingWithdrawals.length) break;
      const batchIssues: Issue[] = [];
      for (const withdrawal of processingWithdrawals) {
        // Status endpoint is keyed by OUR stable request reference, never by the provider's external ID.
        const reference = stablePayoutReference(withdrawal.id);
        try {
          if (!withdrawal.provider) throw new ApiError("Provider withdrawal legacy tidak diketahui; verifikasi identitas provider dahulu.", "PAYOUT_PROVIDER_IDENTITY_REQUIRED", 409);
          const provider = getPayoutProvider(withdrawal.provider);
          const status = await provider.getDisbursementStatus(reference);
          if (status.status === "UNKNOWN") {
            batchIssues.push({ severity: "CRITICAL", code: "PROVIDER_STATUS_UNKNOWN", entityType: "withdrawal", entityId: withdrawal.id, message: "404/status ambigu bukan bukti gagal; dana/status tidak diubah." });
            continue;
          }
          assertDisbursementEvidence(status, { reference, amount: withdrawal.amount, provider: withdrawal.provider, providerReference: withdrawal.providerReference });
          if (status.status === "SUCCESS") {
            if (!scope.recoverProviderSuccess) {
              batchIssues.push({ severity: "CRITICAL", code: "PROVIDER_SUCCESS_DB_PROCESSING", entityType: "withdrawal", entityId: withdrawal.id, actualValue: { providerStatus: status.status, providerReference: status.providerReference, recovery: "NOT_REQUESTED" }, message: "Provider SUCCESS diverifikasi, tetapi mode audit tidak mengubah status/saldo. Recovery eksplisit perlu approval super-admin." });
              continue;
            }
            const finalized = await processWithdrawal({
              withdrawalId: withdrawal.id, decision: "SUCCESS", adminRole: "SYSTEM", adminId: scope.recoveryActorId,
              source: "PROVIDER", providerEvidence: status, expectedAttemptCount: withdrawal.attemptCount,
            });
            batchIssues.push({ severity: "CRITICAL", code: "PROVIDER_SUCCESS_DB_PROCESSING", entityType: "withdrawal", entityId: withdrawal.id, actualValue: { dbStatus: finalized.status, providerStatus: status.status, recovery: finalized.replayed ? "ALREADY_FINALIZED" : "FINALIZED" }, message: "Recovery eksplisit memakai bukti provider, row lock, attempt fencing, dan ledger idempotent." });
          } else if (status.status === "FAILED_FINAL" || status.status === "FAILED_RETRYABLE") {
            batchIssues.push({ severity: "CRITICAL", code: "PROVIDER_FAILURE_DB_PROCESSING", entityType: "withdrawal", entityId: withdrawal.id, actualValue: { providerStatus: status.status }, message: "Kegagalan provider terkonfirmasi; audit tidak melakukan retry/refund otomatis." });
          }
        } catch (error) {
          batchIssues.push({ severity: "CRITICAL", code: "PROVIDER_SUCCESS_RECOVERY_FAILED", entityType: "withdrawal", entityId: withdrawal.id, actualValue: { error: error instanceof Error ? error.message : String(error) }, message: "Status/bukti payout tidak dapat diverifikasi atau recovery gagal; jangan ubah saldo." });
        }
      }
      await persistProviderIssues(batchIssues);
      afterId = processingWithdrawals[processingWithdrawals.length - 1].id;
      if (processingWithdrawals.length < batchSize) break;
    }
  } catch (error) {
    await persistProviderIssues([{ severity: "CRITICAL", code: "PROVIDER_RECONCILIATION_UNAVAILABLE", entityType: "provider", actualValue: { error: error instanceof Error ? error.message : String(error) }, message: "Provider payout tidak tersedia untuk pemeriksaan external state." }]);
  }

  if (providerIssueCount) {
    result.issues.push(...providerIssuePreview);
    result.issueCount += providerIssueCount;
    result.status = "FAIL";
  }

  return result;
}

export async function getLatestReconciliation(periodId?: string | null) {
  const [run] = await db.select().from(reconciliationRuns)
    .where(periodId ? eq(reconciliationRuns.periodId, periodId) : sql`true`)
    .orderBy(sql`${reconciliationRuns.createdAt} DESC`).limit(1);
  if (!run) return null;
  const issues = await db.select().from(reconciliationIssues).where(eq(reconciliationIssues.runId, run.id));
  return { ...run, issues };
}
