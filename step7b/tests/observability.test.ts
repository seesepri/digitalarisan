import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOperationalAlerts } from "../src/server/observability-alerts";

test("critical operational conditions produce alerts", () => {
  const alerts = evaluateOperationalAlerts({
    database: true,
    stuckTopups: 1,
    stuckWithdrawals: 1,
    failedFinalJobs: 1,
    expiredJobLeases: 1,
    failedReconciliations24h: 1,
    recentPaymentFailures: 5,
    recentWithdrawalFailures: 5,
    checkedAt: new Date().toISOString(),
  });
  const names = alerts.map((x) => x.name);
  assert.ok(names.includes("stuck_topups"));
  assert.ok(names.includes("stuck_withdrawals"));
  assert.ok(names.includes("job_failed_final"));
  assert.ok(names.includes("reconciliation_failed"));
});

test("healthy operational snapshot has no alerts", () => {
  const alerts = evaluateOperationalAlerts({ database: true, stuckTopups: 0, stuckWithdrawals: 0, failedFinalJobs: 0, expiredJobLeases: 0, failedReconciliations24h: 0, recentPaymentFailures: 0, recentWithdrawalFailures: 0, checkedAt: new Date().toISOString() });
  assert.deepEqual(alerts, []);
});
