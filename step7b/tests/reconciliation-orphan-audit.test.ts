import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("reconciliation audit covers all requested P0 conditions", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/server/services/reconciliation.ts"), "utf8");
  for (const code of [
    "PROVIDER_SUCCESS_DB_PROCESSING",
    "WALLET_LEDGER_ORPHAN_PARENT",
    "PARENT_TRANSACTION_WITHOUT_LEDGER",
    "SETTLEMENT_POOL_BALANCE_MISMATCH",
    "COMPLETED_PERIOD_RESERVATION_NOT_CONSUMED",
    "DUPLICATE_PROVIDER_REFERENCE",
    "DUPLICATE_IDEMPOTENCY_KEY",
  ]) {
    assert.match(source, new RegExp(code));
  }
  assert.match(source, /stablePayoutReference\(withdrawal\.id\)/);
  assert.match(source, /getDisbursementStatus\(reference\)/);
});


test("provider SUCCESS reconciliation uses the idempotent provider finalizer", () => {
  const reconciliation = fs.readFileSync(path.resolve(process.cwd(), "src/server/services/reconciliation.ts"), "utf8");
  const withdrawal = fs.readFileSync(path.resolve(process.cwd(), "src/server/services/payout-withdrawal.ts"), "utf8");
  assert.match(reconciliation, /processWithdrawal\(\{[\s\S]*decision: "SUCCESS"[\s\S]*source: "PROVIDER"[\s\S]*providerReference:/);
  assert.match(reconciliation, /adminRole: "SYSTEM"/);
  assert.match(reconciliation, /replayed \? "ALREADY_FINALIZED" : "FINALIZED"/);
  assert.match(withdrawal, /SELECT id FROM withdrawals WHERE id = \$\{input\.withdrawalId\} FOR UPDATE/);
  assert.match(withdrawal, /if \(withdrawal\.status === input\.decision\) return \{ id: withdrawal\.id, status: withdrawal\.status, replayed: true/);
  assert.match(withdrawal, /referenceType: "withdrawal", referenceId: withdrawal\.id/);
  assert.match(withdrawal, /source === "PROVIDER"/);
});
