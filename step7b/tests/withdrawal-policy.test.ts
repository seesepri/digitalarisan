import assert from "node:assert/strict";
import test from "node:test";
import { isWithdrawalRetryDue, resolveWithdrawalFailure } from "@/server/services/withdrawal-policy";

test("retry exhaustion refunds only after confirmed failed transfers, with terminal metadata", () => {
  assert.deepEqual(resolveWithdrawalFailure({ decision: "FAILED_RETRYABLE", attemptCount: 5, maxAttempts: 5, failureConfirmed: true }), {
    status: "FAILED_FINAL", errorCode: "PROVIDER_RETRIES_EXHAUSTED",
    errorMessage: "Batas retry tercapai setelah kegagalan transfer dikonfirmasi provider; dana dikembalikan ke saldo tersedia.",
  });
});
test("unconfirmed failure must never become refund, even with an exhausted retry budget", () => {
  for (const decision of ["FAILED_RETRYABLE", "FAILED_FINAL"] as const) {
    assert.throws(() => resolveWithdrawalFailure({ decision, attemptCount: 5, maxAttempts: 5 }), /tidak boleh dilepas/);
  }
});
test("confirmed retryable failure retains funds and has consistent metadata", () => {
  const result = resolveWithdrawalFailure({ decision: "FAILED_RETRYABLE", attemptCount: 4, maxAttempts: 5, failureConfirmed: true });
  assert.equal(result.status, "FAILED_RETRYABLE");
  assert.equal(result.errorCode, "PROVIDER_RETRYABLE_FAILURE");
  assert.match(result.errorMessage ?? "", /dana tetap ditahan/);
});
test("success has no failure metadata", () => {
  assert.deepEqual(resolveWithdrawalFailure({ decision: "SUCCESS", attemptCount: 1, maxAttempts: 5 }), { status: "SUCCESS", errorCode: null, errorMessage: null });
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
