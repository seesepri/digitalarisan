import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { HttpPayoutProvider, stablePayoutReference } from "@/server/services/payout-provider";

const enabled = process.env.PAYOUT_E2E === "1" && process.env.PAYOUT_E2E_CONFIRM === "YES";

test("payout provider sandbox create/status E2E", { skip: !enabled }, async () => {
  assert.ok(process.env.PAYOUT_PROVIDER_BASE_URL, "PAYOUT_PROVIDER_BASE_URL is required");
  assert.ok(process.env.PAYOUT_PROVIDER_API_KEY, "PAYOUT_PROVIDER_API_KEY is required");
  const provider = new HttpPayoutProvider(process.env.PAYOUT_PROVIDER || "sandbox");
  const reference = stablePayoutReference(`sandbox-${Date.now()}-${randomUUID()}`);
  const amount = Number(process.env.PAYOUT_E2E_AMOUNT || 10_000);
  const created = await provider.createDisbursement({
    reference,
    bankName: process.env.PAYOUT_E2E_BANK_NAME || "SANDBOX",
    accountName: process.env.PAYOUT_E2E_ACCOUNT_NAME || "SANDBOX TEST",
    accountNumber: process.env.PAYOUT_E2E_ACCOUNT_NUMBER || "SANDBOX",
    amount,
  });
  assert.equal(created.reference, reference);
  assert.ok(created.providerReference);
  const status = await provider.getDisbursementStatus(reference);
  assert.ok(["PROCESSING", "SUCCESS", "FAILED_RETRYABLE", "FAILED_FINAL"].includes(status.status));
});
