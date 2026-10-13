import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/payment_provider_unit_test";
const { HttpPaymentProvider } = await import("@/server/services/payment-provider");

const secret = "test-secret";

function signature(timestamp: string, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

test("payment webhook signature accepts a fresh valid signature", () => {
  process.env.PAYMENT_WEBHOOK_SECRET = secret;
  const provider = new HttpPaymentProvider("test");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ eventId: "evt-1", reference: "topup-1", status: "PAID", currency: "IDR", amount: 50_000 });
  assert.doesNotThrow(() => provider.verifyWebhook({ rawBody: body, timestamp, signature: signature(timestamp, body) }));
});

test("payment webhook signature rejects a tampered body", () => {
  process.env.PAYMENT_WEBHOOK_SECRET = secret;
  const provider = new HttpPaymentProvider("test");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const original = JSON.stringify({ eventId: "evt-1", reference: "topup-1", status: "PAID", currency: "IDR", amount: 50_000 });
  const tampered = JSON.stringify({ eventId: "evt-2", reference: "topup-1", status: "PAID", currency: "IDR", amount: 50_000 });
  assert.throws(() => provider.verifyWebhook({ rawBody: tampered, timestamp, signature: signature(timestamp, original) }));
});

test("payment webhook signature rejects a stale timestamp", () => {
  process.env.PAYMENT_WEBHOOK_SECRET = secret;
  const provider = new HttpPaymentProvider("test");
  const timestamp = (Math.floor(Date.now() / 1000) - 3600).toString();
  const body = JSON.stringify({ eventId: "evt-1", reference: "topup-1", status: "PAID", currency: "IDR", amount: 50_000 });
  assert.throws(() => provider.verifyWebhook({ rawBody: body, timestamp, signature: signature(timestamp, body) }));
});
