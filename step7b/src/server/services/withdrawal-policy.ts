export type WithdrawalOutcome = "SUCCESS" | "FAILED_RETRYABLE" | "FAILED_FINAL";
export type WithdrawalFinalStatus = "SUCCESS" | "FAILED_RETRYABLE" | "FAILED_FINAL";

export function resolveWithdrawalFailure(input: {
  decision: WithdrawalOutcome;
  attemptCount: number;
  maxAttempts: number;
}): {
  status: WithdrawalFinalStatus;
  errorCode: string | null;
  errorMessage: string | null;
} {
  const exhausted = input.decision === "FAILED_RETRYABLE" && input.attemptCount >= input.maxAttempts;
  const status = exhausted ? "FAILED_FINAL" : input.decision;

  if (status === "SUCCESS") {
    return { status, errorCode: null, errorMessage: null };
  }
  if (status === "FAILED_RETRYABLE") {
    return {
      status,
      errorCode: "PROVIDER_RETRYABLE_FAILURE",
      errorMessage: "Provider payout gagal sementara; dana tetap ditahan untuk retry.",
    };
  }
  return {
    status,
    errorCode: "PROVIDER_FINAL_FAILURE",
    errorMessage: "Provider payout gagal permanen; dana dikembalikan ke saldo tersedia.",
  };
}

export function isWithdrawalRetryDue(nextRetryAt: Date | null | undefined, now = new Date()): boolean {
  return nextRetryAt instanceof Date && Number.isFinite(nextRetryAt.getTime()) && nextRetryAt <= now;
}
