import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
process.env.DATABASE_URL = "postgresql://127.0.0.1:1/midtrans_provider_unit_test";
const { MidtransPaymentProvider } = await import("@/server/services/payment-provider");

const serverKey = "midtrans-test-server-key";
process.env.MIDTRANS_IS_PRODUCTION = "false";

function payload(overrides: Record<string, unknown> = {}) {
  const base = {
    order_id: "topup-123",
    status_code: "200",
    gross_amount: "50000.00",
    transaction_id: "trx-123",
    transaction_status: "settlement",
    fraud_status: "accept",
  };
  const body = { ...base, ...overrides } as Record<string, unknown>;
  body.signature_key = createHash("sha512")
    .update(`${body.order_id}${body.status_code}${body.gross_amount}${serverKey}`)
    .digest("hex");
  return JSON.stringify(body);
}

test("Midtrans settlement signature is accepted and normalized to PAID", () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  const provider = new MidtransPaymentProvider();
  const event = provider.verifyWebhook({ rawBody: payload() });
  assert.equal(event.provider, "midtrans");
  assert.equal(event.reference, "topup-123");
  assert.equal(event.amount, 50000);
  assert.equal(event.currency, "IDR");
  assert.equal(event.status, "PAID");
});

test("Midtrans pending notification is normalized to PROCESSING", () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  const provider = new MidtransPaymentProvider();
  const event = provider.verifyWebhook({ rawBody: payload({ transaction_status: "pending", transaction_id: "trx-pending" }) });
  assert.equal(event.status, "PROCESSING");
});

test("Midtrans expire notification is normalized to EXPIRED", () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  const provider = new MidtransPaymentProvider();
  const event = provider.verifyWebhook({ rawBody: payload({ transaction_status: "expire", transaction_id: "trx-expire" }) });
  assert.equal(event.status, "EXPIRED");
});

test("Midtrans invalid signature is rejected", () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  const provider = new MidtransPaymentProvider();
  const body = JSON.parse(payload());
  body.signature_key = "0".repeat(128);
  assert.throws(() => provider.verifyWebhook({ rawBody: JSON.stringify(body) }), /Signature webhook Midtrans tidak valid/);
});

test("Midtrans changed amount is rejected when signature no longer matches", () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  const provider = new MidtransPaymentProvider();
  const body = JSON.parse(payload());
  body.gross_amount = "60000.00";
  assert.throws(() => provider.verifyWebhook({ rawBody: JSON.stringify(body) }), /Signature webhook Midtrans tidak valid/);
});

test("Midtrans non-zero fractional IDR amount is rejected", () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  const provider = new MidtransPaymentProvider();
  assert.throws(
    () => provider.verifyWebhook({ rawBody: payload({ gross_amount: "50000.50", transaction_id: "trx-fractional" }) }),
    /Nominal pembayaran provider tidak valid/,
  );
});


test("Midtrans create payment sends the stable reference as Idempotency-Key", async () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  process.env.MIDTRANS_IS_PRODUCTION = "false";
  const provider = new MidtransPaymentProvider();
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ token: "token-1", redirect_url: "https://app.sandbox.midtrans.com/snap/v2/vtweb/token-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await provider.createPayment({
      reference: "topup-idempotency-123",
      amount: 50000,
      currency: "IDR",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      callbackUrl: "https://example.test/callback",
    });
    const headers = new Headers(captured?.headers);
    assert.equal(headers.get("Idempotency-Key"), "topup-idempotency-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Midtrans requires an explicit sandbox/production mode", () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  delete process.env.MIDTRANS_IS_PRODUCTION;
  assert.throws(() => new MidtransPaymentProvider(), /MIDTRANS_IS_PRODUCTION harus dikonfigurasi secara eksplisit/);
  process.env.MIDTRANS_IS_PRODUCTION = "false";
});

test("Midtrans rejects custom API hosts that could receive the server key", () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  process.env.MIDTRANS_IS_PRODUCTION = "false";
  process.env.MIDTRANS_BASE_URL = "http://attacker.example";
  assert.throws(() => new MidtransPaymentProvider(), /MIDTRANS_BASE_URL harus HTTPS dan sesuai mode Midtrans/);
  delete process.env.MIDTRANS_BASE_URL;
});

test("Midtrans rejects a provider response with a foreign checkout host", async () => {
  process.env.MIDTRANS_SERVER_KEY = serverKey;
  process.env.MIDTRANS_IS_PRODUCTION = "false";
  const provider = new MidtransPaymentProvider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ token: "token-1", redirect_url: "https://attacker.example/pay" }), { status: 201 });
  try {
    await assert.rejects(
      () => provider.createPayment({ reference: "topup-foreign-host", amount: 50_000, currency: "IDR", expiresAt: new Date(Date.now() + 60_000), callbackUrl: "https://example.test/callback" }),
      /Host checkout URL Midtrans tidak diizinkan/,
    );
  } finally { globalThis.fetch = originalFetch; }
});
