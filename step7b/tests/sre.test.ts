import test from "node:test";
import assert from "node:assert/strict";

const source = await import("../src/server/sre");

test("SLO definitions protect financial integrity as the highest target", () => {
  const financial = source.SLO_DEFINITIONS.find((x) => x.name === "financial_integrity");
  assert.equal(financial?.target, 0.9999);
});

test("alert correlation deduplicates by dependency and fingerprint", () => {
  const alerts = source.correlateAlerts([
    { name: "payment_failure_spike", severity: "warning", message: "a", dependency: "payment-provider" },
    { name: "payment_failure_spike", severity: "critical", message: "b", dependency: "payment-provider" },
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "critical");
});

test("error budget helper is bounded", () => {
  assert.equal(source.errorBudgetRemaining(0.995, 1), 1);
  assert.equal(source.errorBudgetRemaining(0.995, 0.9), 0);
});
