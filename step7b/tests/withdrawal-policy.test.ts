import assert from "node:assert/strict";
import test from "node:test";
import { isWithdrawalRetryDue, resolveWithdrawalFailure } from "@/server/services/withdrawal-policy";

test("exhausted retry is finalized with final-failure metadata", () => {
  assert.deepEqual(resolveWithdrawalFailure({ decision: "FAILED_RETRYABLE", attemptCount: 5, maxAttempts: 5 }), {
    status: "FAILED_FINAL",
    errorCode: "PROVIDER_FINAL_FAILURE",
    errorMessage: "Provider payout gagal permanen; dana dikembalikan ke saldo tersedia.",
  });
});

test("retryable provider failure retains funds and reports retryable metadata", () => {
  assert.deepEqual(resolveWithdrawalFailure({ decision: "FAILED_RETRYABLE", attemptCount: 4, maxAttempts: 5 }), {
    status: "FAILED_RETRYABLE",
    errorCode: "PROVIDER_RETRYABLE_FAILURE",
    errorMessage: "Provider payout gagal sementara; dana tetap ditahan untuk retry.",
  });
});

test("retry with no schedule or a future deadline is not due", () => {
  const now = new Date("2026-10-13T12:00:00.000Z");
  assert.equal(isWithdrawalRetryDue(null, now), false);
  assert.equal(isWithdrawalRetryDue(undefined, now), false);
  assert.equal(isWithdrawalRetryDue(new Date(now.getTime() + 1), now), false);
});

test("retry becomes due at or after its recorded deadline", () => {
  const now = new Date("2026-10-13T12:00:00.000Z");
  assert.equal(isWithdrawalRetryDue(now, now), true);
  assert.equal(isWithdrawalRetryDue(new Date(now.getTime() - 1), now), true);
});
