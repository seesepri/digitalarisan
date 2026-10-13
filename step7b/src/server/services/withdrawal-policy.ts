export type WithdrawalOutcome = "SUCCESS" | "FAILED_RETRYABLE" | "FAILED_FINAL";
export type WithdrawalFinalStatus = WithdrawalOutcome;
export const MAX_WITHDRAWAL_ATTEMPTS = 5;

export function resolveWithdrawalFailure(input: {
  decision: WithdrawalOutcome;
  attemptCount: number;
  maxAttempts: number;
  failureConfirmed?: boolean;
}): {
  status: WithdrawalFinalStatus;
  errorCode: string | null;
  errorMessage: string | null;
} {
  if (input.decision === "SUCCESS") return { status: "SUCCESS", errorCode: null, errorMessage: null };
  // Exhausting a retry budget never proves that an external transfer failed.
  if (input.failureConfirmed !== true) throw new Error("Provider failure belum dikonfirmasi; dana tidak boleh dilepas.");
  const exhausted = input.decision === "FAILED_RETRYABLE" && input.attemptCount >= input.maxAttempts;
  if (input.decision === "FAILED_RETRYABLE" && !exhausted) {
    return {
      status: "FAILED_RETRYABLE", errorCode: "PROVIDER_RETRYABLE_FAILURE",
      errorMessage: "Provider mengonfirmasi transfer gagal sementara; dana tetap ditahan untuk retry.",
    };
  }
  return {
    status: "FAILED_FINAL",
    errorCode: exhausted ? "PROVIDER_RETRIES_EXHAUSTED" : "PROVIDER_FINAL_FAILURE",
    errorMessage: exhausted
      ? "Batas retry tercapai setelah kegagalan transfer dikonfirmasi provider; dana dikembalikan ke saldo tersedia."
      : "Provider mengonfirmasi transfer gagal permanen; dana dikembalikan ke saldo tersedia.",
  };
}

export function isWithdrawalRetryDue(nextRetryAt: Date | null | undefined, now = new Date()): boolean {
  return nextRetryAt instanceof Date && Number.isFinite(nextRetryAt.getTime()) && nextRetryAt <= now;
}
