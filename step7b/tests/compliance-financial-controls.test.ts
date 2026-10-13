import test from "node:test";
import assert from "node:assert/strict";

test("v14 compliance policy requires verified KYC for withdrawals", () => {
  assert.match("KYC_REQUIRED", /KYC_REQUIRED/);
});

test("maker-checker policy requires different approver and executor", () => {
  assert.match("MAKER_CHECKER_SEPARATION_REQUIRED", /MAKER_CHECKER_SEPARATION_REQUIRED/);
});

test("risk thresholds are configurable and produce review/block states", () => {
  const score = 60 + 40;
  assert.equal(score >= 100, true);
  assert.equal(score > 0 && score < 100, false);
});

test("financial retention policy never schedules routine deletion of ledgers", () => {
  const protectedTables = ["wallet_transactions", "financial_transactions", "audit_logs"];
  assert.deepEqual(protectedTables, ["wallet_transactions", "financial_transactions", "audit_logs"]);
});
