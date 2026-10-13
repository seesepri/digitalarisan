import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MidtransPaymentProvider } from "@/server/services/payment-provider";

const enabled = process.env.MIDTRANS_E2E === "1";

test("Midtrans sandbox create/status E2E", { skip: !enabled }, async () => {
  assert.ok(process.env.MIDTRANS_SERVER_KEY, "MIDTRANS_SERVER_KEY is required");
  process.env.MIDTRANS_IS_PRODUCTION = "false";
  const provider = new MidtransPaymentProvider();
  const reference = `E2E-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const created = await provider.createPayment({
    reference,
    amount: Number(process.env.MIDTRANS_E2E_AMOUNT || 10_000),
    currency: "IDR",
    expiresAt: new Date(Date.now() + 15 * 60_000),
    callbackUrl: process.env.PAYMENT_RETURN_URL || "https://example.test/payment/return",
  });
  assert.equal(created.provider, "midtrans");
  assert.ok(created.providerReference);
  const status = await provider.getPaymentStatus(reference);
  assert.equal(status.reference, reference);
  assert.ok(["PROCESSING", "PAID", "EXPIRED", "FAILED"].includes(status.status));
});
