export type OperationalSnapshot = {
  database: boolean;
  stuckTopups: number;
  stuckWithdrawals: number;
  failedFinalJobs: number;
  expiredJobLeases: number;
  failedReconciliations24h: number;
  recentPaymentFailures: number;
  recentWithdrawalFailures: number;
  checkedAt: string;
};

export function evaluateOperationalAlerts(snapshot: OperationalSnapshot) {
  const alerts: Array<{ name: string; severity: "warning" | "critical"; message: string }> = [];
  if (!snapshot.database) alerts.push({ name: "database_unavailable", severity: "critical", message: "Database tidak dapat diakses." });
  if (snapshot.failedFinalJobs > 0) alerts.push({ name: "job_failed_final", severity: "critical", message: `${snapshot.failedFinalJobs} job berada pada FAILED_FINAL.` });
  if (snapshot.expiredJobLeases > 0) alerts.push({ name: "job_expired_lease", severity: "warning", message: `${snapshot.expiredJobLeases} job RUNNING memiliki lease yang kedaluwarsa.` });
  if (snapshot.stuckTopups > 0) alerts.push({ name: "stuck_topups", severity: "critical", message: `${snapshot.stuckTopups} top-up PENDING/PROCESSING lebih dari 15 menit.` });
  if (snapshot.stuckWithdrawals > 0) alerts.push({ name: "stuck_withdrawals", severity: "critical", message: `${snapshot.stuckWithdrawals} withdrawal PENDING/PROCESSING lebih dari 30 menit.` });
  if (snapshot.failedReconciliations24h > 0) alerts.push({ name: "reconciliation_failed", severity: "critical", message: `${snapshot.failedReconciliations24h} reconciliation gagal dalam 24 jam terakhir.` });
  if (snapshot.recentPaymentFailures >= 5) alerts.push({ name: "payment_failure_spike", severity: "warning", message: `${snapshot.recentPaymentFailures} payment gagal dalam 15 menit terakhir.` });
  if (snapshot.recentWithdrawalFailures >= 5) alerts.push({ name: "withdrawal_failure_spike", severity: "warning", message: `${snapshot.recentWithdrawalFailures} withdrawal gagal dalam 15 menit terakhir.` });
  return alerts;
}
